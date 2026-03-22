/**
 * cryptoMMExecutor.js
 * Core executor for the crypto market maker bot.
 * Posts two-sided quotes on Polymarket crypto markets to earn the bid-ask spread.
 * Supports both 5-minute and 1H markets via slotDuration-derived timing.
 *
 * Timeline per market (proportional to slotDuration):
 *   T-(75%): POST neutral two-sided quotes
 *   T-(25%): CHECK directional signal -> SKEW quotes if signal fires
 *   T-10s/60s: CANCEL all orders before resolution
 *   T+3min:    CHECK outcome, compute PnL
 */

import { Side, OrderType } from '@polymarket/clob-client';
import config from '../config/index.js';
import { getClient, submitOrderTimed } from './client.js';
import { getCandlesSince, getOrderFlowSince } from './binanceFeed.js';
import { ALL_SIGNALS } from '../backtest/signals.js';
import { checkResolutionOnChain } from './ctf.js';
import { validateOrderbook, isCircuitBroken } from '../utils/orderbookGuard.js';
import logger from '../utils/logger.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const LOG_FILE = path.join(DATA_DIR, 'crypto_mm.jsonl');

// ── Configuration (from environment) ────────────────────────────────────────

const CMM_ASSETS = (process.env.CMM_ASSETS || 'btc,eth,sol').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const CMM_SHARES = parseFloat(process.env.CMM_SHARES || '20');
const CMM_SPREAD = parseFloat(process.env.CMM_SPREAD || '0.04');
const CMM_SKEW_SPREAD = parseFloat(process.env.CMM_SKEW_SPREAD || '0.02');
const CMM_MAX_DAILY_LOSS = parseFloat(process.env.CMM_MAX_DAILY_LOSS || '50');
const CMM_SIGNAL_MINUTES = parseInt(process.env.CMM_SIGNAL_MINUTES || '3', 10);
const CMM_SIGNAL_NAME = process.env.CMM_SIGNAL || 'momentum';

const SLOT_SEC = 5 * 60; // default / fallback
const PAPER_MODE = config.dryRun;

// Wallet address used for getTrades fill detection
const CMM_MAKER_ADDRESS = config.tailSweepProxyWallet || config.proxyWallet;

// Slug label lookup by slot duration (for checkOutcome)
const SLOT_DURATION_LABEL = { 300: '5m', 3600: '1h', 14400: '4h', 86400: 'daily', 604800: 'weekly' };

// ── State ───────────────────────────────────────────────────────────────────

const _pendingMarkets = new Map(); // key -> { timers: [...], market }
const _activeOrders = new Map();   // conditionId -> { yesBidId, yesAskId, noBidId, noAskId, market, fills: [] }

const _stats = {
    marketsQuoted: 0,
    fills: 0,
    wins: 0,
    losses: 0,
    dailyPnl: 0,
    dailyRewardEstimate: 0,
    dailyFeesSaved: 0,
};

let _dailyLossResetDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC

// Paper mode state
const _paper = {
    balance: 1000,
    orders: new Map(), // fakeOrderId -> { conditionId, tokenId, side, price, shares }
};
let _paperOrderSeq = 0;

// ── Helpers ─────────────────────────────────────────────────────────────────

function appendLog(obj) {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    try {
        fs.appendFileSync(LOG_FILE, JSON.stringify(obj) + '\n', 'utf-8');
    } catch (err) {
        logger.error(`CMM: log write failed — ${err.message}`);
    }
}

function logAction(action, data) {
    appendLog({ ts: new Date().toISOString(), action, ...data });
}

function computeFeeShares(shares, price) {
    return shares * 0.25 * Math.pow(price * (1 - price), 2);
}

function roundToTick(price, tickSize) {
    const tick = parseFloat(tickSize) || 0.01;
    // Clamp to [0.01, 0.99]
    const rounded = Math.round(price / tick) * tick;
    return Math.max(0.01, Math.min(0.99, Math.round(rounded * 100) / 100));
}

/**
 * Derive quote/skew/cleanup timing offsets from slot duration.
 * 5-min: quote T-240s, skew T-60s, cleanup T-10s
 * 1H:    quote T-2700s (45min), skew T-900s (15min), cleanup T-60s
 */
function getSlotTimings(slotDuration) {
    if (slotDuration <= 300) {
        return { quoteOffsetMs: 240_000, skewOffsetMs: 60_000, cleanupOffsetMs: 10_000 };
    }
    const slotMs = slotDuration * 1000;
    return {
        quoteOffsetMs:   Math.round(slotMs * 0.75), // 45 min for 1H
        skewOffsetMs:    Math.round(slotMs * 0.25), // 15 min for 1H
        cleanupOffsetMs: 60_000,                    // 1 min for all longer markets
    };
}

function resetDailyLossIfNeeded() {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== _dailyLossResetDate) {
        logger.info(`CMM: daily loss reset (was $${_stats.dailyPnl.toFixed(2)})`);
        _stats.dailyPnl = 0;
        _stats.dailyRewardEstimate = 0;
        _stats.dailyFeesSaved = 0;
        _dailyLossResetDate = today;
    }
}

async function fetchOrderbook(tokenId) {
    try {
        const resp = await fetch(`${config.clobHost}/book?token_id=${tokenId}`, {
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(5000),
        });
        if (!resp.ok) return null;
        const data = await resp.json();
        const bids = data.bids || [];
        const asks = data.asks || [];
        const bestBid = bids.length > 0 ? parseFloat(bids[bids.length - 1].price) : 0;
        const bestAsk = asks.length > 0 ? parseFloat(asks[asks.length - 1].price) : 1;
        const askLiquidity = asks.reduce((sum, a) => sum + parseFloat(a.size || 0), 0);
        const bidLiquidity = bids.reduce((sum, b) => sum + parseFloat(b.size || 0), 0);
        return { bestBid, bestAsk, askLiquidity, bidLiquidity, spread: Math.round((bestAsk - bestBid) * 10000) / 10000 };
    } catch { return null; }
}

async function checkOutcome(market) {
    const slotDuration = market.slotDuration || SLOT_SEC;
    const tfLabel = SLOT_DURATION_LABEL[slotDuration] || '5m';
    const slug = `${market.asset}-updown-${tfLabel}-${market.slotTimestamp}`;
    try {
        const resp = await fetch(`${config.gammaHost}/markets/slug/${slug}`, { signal: AbortSignal.timeout(10000) });
        if (!resp.ok) return null;
        const data = await resp.json();
        if (!data) return null;

        let prices = data.outcomePrices ?? data.outcome_prices;
        if (typeof prices === 'string') try { prices = JSON.parse(prices); } catch { prices = null; }

        if (Array.isArray(prices) && prices.length >= 2) {
            const p0 = parseFloat(prices[0]);
            const p1 = parseFloat(prices[1]);
            if (p0 > 0.95 && p1 < 0.05) return 'UP';
            if (p1 > 0.95 && p0 < 0.05) return 'DOWN';
        }
        return null;
    } catch { return null; }
}

// ── Order placement ─────────────────────────────────────────────────────────

async function placeOrder(market, tokenId, side, price, shares, label) {
    const tickSize = market.tickSize || '0.01';
    const roundedPrice = roundToTick(price, tickSize);

    if (PAPER_MODE) {
        const fakeId = `CMM-PAPER-${Date.now()}-${++_paperOrderSeq}`;
        const cost = side === Side.BUY ? roundedPrice * shares : 0;
        if (side === Side.BUY && _paper.balance < cost) {
            logger.info(`CMM[PAPER]: ${label} skipped — insufficient balance ($${_paper.balance.toFixed(2)} < $${cost.toFixed(2)})`);
            return null;
        }
        if (side === Side.BUY) _paper.balance -= cost;
        _paper.orders.set(fakeId, { conditionId: market.conditionId, tokenId, side, price: roundedPrice, shares });
        logger.info(`CMM[PAPER]: ${label} @ $${roundedPrice.toFixed(2)} x ${shares}sh`);
        logAction('place_paper', { conditionId: market.conditionId, asset: market.asset, side: side === Side.BUY ? 'BUY' : 'SELL', price: roundedPrice, shares, orderId: fakeId });
        return fakeId;
    }

    try {
        const { res } = await submitOrderTimed(
            { tokenID: tokenId, side, price: roundedPrice, size: shares },
            { tickSize, negRisk: market.negRisk || false },
            OrderType.GTC,
        );
        if (res?.success) {
            logger.info(`CMM: ${label} placed — ${res.orderID?.slice(0, 12)}... @ $${roundedPrice.toFixed(2)} x ${shares}sh`);
            logAction('place', { conditionId: market.conditionId, asset: market.asset, side: side === Side.BUY ? 'BUY' : 'SELL', price: roundedPrice, shares, orderId: res.orderID });
            return res.orderID;
        } else {
            logger.warn(`CMM: ${label} rejected — ${res?.errorMsg || 'unknown'}`);
            return null;
        }
    } catch (err) {
        logger.warn(`CMM: ${label} error — ${err.message}`);
        return null;
    }
}

async function cancelOrder(orderId) {
    if (!orderId) return;

    if (PAPER_MODE) {
        const o = _paper.orders.get(orderId);
        if (o && o.side === Side.BUY) {
            _paper.balance += o.price * o.shares; // refund reserved cost
        }
        _paper.orders.delete(orderId);
        return;
    }

    try {
        const client = getClient();
        await client.cancelOrder(orderId);
    } catch { /* best effort */ }
}

// ── Core functions ──────────────────────────────────────────────────────────

async function postNeutralQuotes(market) {
    const { conditionId, yesTokenId, noTokenId, asset } = market;
    const label = `${asset.toUpperCase()} ${(market.question || '').slice(0, 30)}`;

    if (isCircuitBroken()) {
        logger.warn(`CMM: ${label} — circuit breaker active, skipping quotes`);
        return;
    }

    if (isDailyLossHit()) {
        logger.warn(`CMM: ${label} — daily loss limit hit, skipping quotes`);
        return;
    }

    // Fetch orderbooks for both sides
    const [rawYesBook, rawNoBook] = await Promise.all([
        fetchOrderbook(yesTokenId),
        fetchOrderbook(noTokenId),
    ]);

    const yesBook = validateOrderbook(yesTokenId, rawYesBook);
    const noBook = validateOrderbook(noTokenId, rawNoBook);

    if (!yesBook || !noBook) {
        logger.warn(`CMM: ${label} — orderbook unavailable, skipping quotes`);
        return;
    }

    // Calculate midpoints
    const yesMid = (yesBook.bestBid + yesBook.bestAsk) / 2;
    const noMid = (noBook.bestBid + noBook.bestAsk) / 2;
    const tickSize = market.tickSize || '0.01';
    const shares = CMM_SHARES;

    // Place BID and ASK on both YES and NO at mid +/- spread
    const yesBidPrice = yesMid - CMM_SPREAD / 2;
    const yesAskPrice = yesMid + CMM_SPREAD / 2;
    const noBidPrice = noMid - CMM_SPREAD / 2;
    const noAskPrice = noMid + CMM_SPREAD / 2;

    const [yesBidId, yesAskId, noBidId, noAskId] = await Promise.all([
        placeOrder(market, yesTokenId, Side.BUY,  yesBidPrice, shares, `${label} YES BID`),
        placeOrder(market, yesTokenId, Side.SELL, yesAskPrice, shares, `${label} YES ASK`),
        placeOrder(market, noTokenId,  Side.BUY,  noBidPrice,  shares, `${label} NO BID`),
        placeOrder(market, noTokenId,  Side.SELL, noAskPrice,  shares, `${label} NO ASK`),
    ]);

    _activeOrders.set(conditionId, {
        yesBidId, yesAskId, noBidId, noAskId,
        market,
        fills: [],
        yesMid, noMid,
        postedAt: Date.now(),
    });

    _stats.marketsQuoted++;

    // Estimate reward: maker orders within ~4c of mid earn rewards
    const rewardEstPerSide = computeFeeShares(shares, yesMid) * 0.20;
    _stats.dailyRewardEstimate += rewardEstPerSide * 4; // 4 orders

    logger.info(
        `CMM: ${label} | YES mid=$${yesMid.toFixed(2)} spread=${yesBook.spread.toFixed(3)} | ` +
        `NO mid=$${noMid.toFixed(2)} spread=${noBook.spread.toFixed(3)} | ${shares}sh per side`
    );

    logAction('quote_neutral', {
        conditionId, asset: asset.toUpperCase(),
        yesMid, noMid, spread: CMM_SPREAD, shares,
        yesBidId, yesAskId, noBidId, noAskId,
    });
}

async function checkSignalAndSkew(market) {
    const { conditionId, yesTokenId, noTokenId, asset } = market;
    const label = `${asset.toUpperCase()} ${(market.question || '').slice(0, 30)}`;
    const orders = _activeOrders.get(conditionId);

    if (!orders) {
        logger.info(`CMM: ${label} — no active orders to skew`);
        return;
    }

    // Get Binance data since market open
    const openAtMs = market.eventStartTime
        ? new Date(market.eventStartTime).getTime()
        : market.slotTimestamp * 1000;

    const candles = getCandlesSince(openAtMs);

    if (candles.length < CMM_SIGNAL_MINUTES) {
        logger.info(`CMM: ${label} — only ${candles.length} candles (need ${CMM_SIGNAL_MINUTES}), keeping neutral`);
        logAction('signal_skip', { conditionId, asset: asset.toUpperCase(), reason: 'insufficient_candles', candleCount: candles.length });
        return;
    }

    // Run signal
    const signalFn = ALL_SIGNALS[CMM_SIGNAL_NAME];
    if (!signalFn) {
        logger.warn(`CMM: unknown signal "${CMM_SIGNAL_NAME}" — keeping neutral`);
        return;
    }

    // For 1H markets, use all available candles (not just first CMM_SIGNAL_MINUTES)
    const slotDuration = market.slotDuration || SLOT_SEC;
    const signalCandles = slotDuration > 300 ? candles : candles.slice(0, CMM_SIGNAL_MINUTES);
    const orderFlow = getOrderFlowSince(openAtMs);
    const { direction, confidence } = signalFn(signalCandles, { orderFlow });

    if (!direction) {
        logger.info(`CMM: ${label} — no signal, keeping neutral quotes`);
        logAction('signal_neutral', { conditionId, asset: asset.toUpperCase(), confidence: confidence ?? 0 });
        return;
    }

    logger.info(`CMM: ${label} — signal=${direction} (${(confidence * 100).toFixed(0)}% conf) — skewing quotes`);

    // Skew logic:
    // If UP: cancel YES ASK + NO BID (don't sell the winner, don't buy the loser)
    //        tighten YES BID closer to mid
    //        post NO ASK at discount
    // If DOWN: mirror

    if (direction === 'UP') {
        // Cancel YES ASK and NO BID
        await Promise.all([
            cancelOrder(orders.yesAskId),
            cancelOrder(orders.noBidId),
        ]);
        orders.yesAskId = null;
        orders.noBidId = null;

        // Tighten YES BID (closer to mid = more aggressive buy of predicted winner)
        await cancelOrder(orders.yesBidId);
        const tightYesBid = orders.yesMid - CMM_SKEW_SPREAD / 2;
        orders.yesBidId = await placeOrder(market, yesTokenId, Side.BUY, tightYesBid, CMM_SHARES, `${label} YES BID (skew UP)`);

        // Post NO ASK at discount (dump NO if held)
        const discountNoAsk = orders.noMid - CMM_SKEW_SPREAD / 2;
        orders.noAskId = await placeOrder(market, noTokenId, Side.SELL, discountNoAsk, CMM_SHARES, `${label} NO ASK (skew UP)`);
    } else {
        // DOWN signal — mirror
        await Promise.all([
            cancelOrder(orders.noAskId),
            cancelOrder(orders.yesBidId),
        ]);
        orders.noAskId = null;
        orders.yesBidId = null;

        // Tighten NO BID
        await cancelOrder(orders.noBidId);
        const tightNoBid = orders.noMid - CMM_SKEW_SPREAD / 2;
        orders.noBidId = await placeOrder(market, noTokenId, Side.BUY, tightNoBid, CMM_SHARES, `${label} NO BID (skew DOWN)`);

        // Post YES ASK at discount
        const discountYesAsk = orders.yesMid - CMM_SKEW_SPREAD / 2;
        orders.yesAskId = await placeOrder(market, yesTokenId, Side.SELL, discountYesAsk, CMM_SHARES, `${label} YES ASK (skew DOWN)`);
    }

    logAction('signal_skew', {
        conditionId, asset: asset.toUpperCase(),
        direction, confidence,
        obi: orderFlow.obiAvg, cvd: orderFlow.cvd,
    });
}

async function cleanupMarket(conditionId) {
    const orders = _activeOrders.get(conditionId);
    if (!orders) return;

    const label = `${orders.market.asset.toUpperCase()} ${(orders.market.question || '').slice(0, 30)}`;
    const ids = [orders.yesBidId, orders.yesAskId, orders.noBidId, orders.noAskId].filter(Boolean);

    for (const id of ids) {
        await cancelOrder(id);
    }

    logger.info(`CMM: ${label} — cleaned up ${ids.length} orders before resolution`);
    logAction('cleanup', { conditionId, asset: orders.market.asset.toUpperCase(), cancelledOrders: ids.length });

    // Don't delete from _activeOrders yet — outcome check needs the fills
}

function scheduleOutcomeCheck(market) {
    const slotDuration = market.slotDuration || SLOT_SEC;
    const slotEnd = market.endTime
        ? new Date(market.endTime).getTime()
        : (market.slotTimestamp + slotDuration) * 1000;
    const waitMs = Math.max(0, slotEnd - Date.now()) + 3 * 60_000; // close + 3 min

    setTimeout(async () => {
        const { conditionId, asset } = market;
        const label = `${asset.toUpperCase()} ${(market.question || '').slice(0, 30)}`;
        const orders = _activeOrders.get(conditionId);
        const fills = orders?.fills || [];

        let outcome = null;
        for (let attempt = 1; attempt <= 6; attempt++) {
            outcome = await checkResolutionOnChain(conditionId);
            if (!outcome) outcome = await checkOutcome(market);
            if (outcome) break;
            if (attempt < 6) await new Promise(r => setTimeout(r, 60_000));
        }

        if (!outcome) {
            logger.warn(`CMM: ${label} — outcome unknown after 6 attempts`);
            _activeOrders.delete(conditionId);
            return;
        }

        // Compute PnL from fills
        let marketPnl = 0;
        for (const fill of fills) {
            const won = (fill.side === 'YES' && outcome === 'UP') || (fill.side === 'NO' && outcome === 'DOWN');
            const feeShares = computeFeeShares(fill.shares, fill.price);
            const payout = won ? (fill.shares - feeShares) : 0;
            const cost = fill.price * fill.shares;
            const pnl = payout - cost;
            marketPnl += pnl;

            if (won) _stats.wins++;
            else _stats.losses++;
        }

        resetDailyLossIfNeeded();
        _stats.dailyPnl += marketPnl;

        const pnlStr = marketPnl >= 0 ? `+$${marketPnl.toFixed(2)}` : `-$${Math.abs(marketPnl).toFixed(2)}`;
        const emoji = marketPnl >= 0 ? 'WIN' : 'LOSS';
        logger.money(`CMM: ${emoji} ${label} — outcome=${outcome} fills=${fills.length} pnl=${pnlStr} | daily=$${_stats.dailyPnl.toFixed(2)}`);

        logAction('outcome', {
            conditionId, asset: asset.toUpperCase(),
            outcome, fills: fills.length, marketPnl,
            dailyPnl: _stats.dailyPnl,
        });

        _activeOrders.delete(conditionId);
    }, waitMs);

    logger.info(`CMM: outcome check scheduled in ${Math.round(waitMs / 1000)}s for ${market.asset.toUpperCase()}`);
}

// ── Fill handling ───────────────────────────────────────────────────────────

export function handleFill(conditionId, orderId, side, price, shares) {
    const orders = _activeOrders.get(conditionId);
    if (!orders) return;

    orders.fills.push({ orderId, side, price, shares, ts: Date.now() });
    _stats.fills++;

    const label = `${orders.market.asset.toUpperCase()}`;
    const fee = computeFeeShares(shares, price);
    _stats.dailyFeesSaved += fee * 0.20; // maker rebate estimate

    logger.info(`CMM: FILL ${label} ${side} @ $${price.toFixed(2)} x ${shares}sh — fee=${fee.toFixed(3)}sh rebate=$${(fee * 0.20).toFixed(3)}`);

    logAction('fill', { conditionId, asset: label, side, price, shares, orderId });

    // Pre-signal cross-hedge: if fill happens before the skew window
    const fillSlotDuration = orders.market.slotDuration || SLOT_SEC;
    const slotEnd = orders.market.endTime
        ? new Date(orders.market.endTime).getTime()
        : (orders.market.slotTimestamp + fillSlotDuration) * 1000;
    const secsLeft = (slotEnd - Date.now()) / 1000;

    if (secsLeft > 60) {
        // Cross-hedge: YES filled -> buy NO at (1 - price - 0.01)
        const hedgePrice = roundToTick(1 - price - 0.01, orders.market.tickSize || '0.01');
        if (hedgePrice > 0 && hedgePrice < 1) {
            const hedgeTokenId = side === 'YES' ? orders.market.noTokenId : orders.market.yesTokenId;
            const hedgeLabel = `${label} HEDGE ${side === 'YES' ? 'NO' : 'YES'}`;
            placeOrder(orders.market, hedgeTokenId, Side.BUY, hedgePrice, shares, hedgeLabel).catch(err =>
                logger.warn(`CMM: hedge failed — ${err.message}`)
            );
            logAction('hedge', { conditionId, asset: label, hedgeSide: side === 'YES' ? 'NO' : 'YES', hedgePrice, shares });
        }
    }
}

// ── Fill detection loop ─────────────────────────────────────────────────────

const _processedFills = new Set(); // trade IDs already processed

/**
 * Fetch recent trades via getTrades() and detect fills for active markets.
 * Uses actual trade events (not order state) — reliable even after cleanup.
 * Called every 15 seconds from the entry point.
 */
export async function checkFills() {
    if (PAPER_MODE) return;
    if (_activeOrders.size === 0) return;
    if (!CMM_MAKER_ADDRESS) return;

    let trades;
    try {
        const client = getClient();
        const result = await client.getTrades({ maker_address: CMM_MAKER_ADDRESS });
        trades = Array.isArray(result) ? result : (result?.data ?? []);
    } catch (err) {
        logger.warn(`CMM: fill check error — ${err.message}`);
        return;
    }

    const cutoffMs = Date.now() - 4 * 60 * 60 * 1000; // look back 4 hours max

    for (const trade of trades) {
        const tradeId = trade.id || trade.trade_id;
        if (!tradeId || _processedFills.has(tradeId)) continue;

        const tradeTs = trade.created_at ? new Date(trade.created_at).getTime() : 0;
        if (tradeTs < cutoffMs) continue;

        const conditionId = trade.condition_id;
        const orders = _activeOrders.get(conditionId);
        if (!orders) continue; // not an active CMM market — skip

        _processedFills.add(tradeId);

        const price = parseFloat(trade.price || '0');
        const shares = parseFloat(trade.size || '0');
        if (shares <= 0) continue;

        // side field is the TAKER's side. If taker BUY → they hit our ASK (we sold).
        // If taker SELL → they hit our BID (we bought).
        const takerBuy = (trade.side || '').toUpperCase() === 'BUY';
        const weAreBuying = !takerBuy; // taker sold to us = we bought

        // Determine YES vs NO by matching asset_id to the market's token IDs
        const assetId = trade.asset_id || trade.token_id;
        const isYes = assetId === orders.market.yesTokenId;
        const fillSide = isYes ? 'YES' : 'NO';

        logger.money(`CMM: FILL ${fillSide} ${weAreBuying ? 'BUY' : 'SELL'} ${shares}sh @ $${price.toFixed(2)}`);
        handleFill(conditionId, trade.maker_order_id, fillSide, price, shares);

        // Pessimistic daily PnL: count BUY fills as cost until outcome resolves
        if (weAreBuying) {
            _stats.dailyPnl -= price * shares;
            if (isDailyLossHit()) {
                logger.error(`CMM: DAILY LOSS LIMIT HIT ($${_stats.dailyPnl.toFixed(2)}) — cancelling all orders`);
                await cancelAllOrders();
                return;
            }
        }
    }
}

// ── Main schedule function ──────────────────────────────────────────────────

export function scheduleMarket(market) {
    const slotDuration = market.slotDuration || SLOT_SEC;
    const slotEnd = market.endTime
        ? new Date(market.endTime).getTime()
        : (market.slotTimestamp + slotDuration) * 1000;

    const key = `${market.asset}-${market.slotTimestamp}`;
    if (_pendingMarkets.has(key)) return;

    if (!CMM_ASSETS.includes(market.asset.toLowerCase())) return;

    resetDailyLossIfNeeded();
    if (isDailyLossHit()) {
        logger.warn(`CMM: daily loss limit hit ($${_stats.dailyPnl.toFixed(2)}) — skipping ${market.asset.toUpperCase()}`);
        return;
    }

    const now = Date.now();
    const timers = [];
    const { quoteOffsetMs, skewOffsetMs, cleanupOffsetMs } = getSlotTimings(slotDuration);

    // Post neutral quotes at T-quoteOffset
    const quoteAtMs = slotEnd - quoteOffsetMs;
    const quoteDelay = Math.max(0, quoteAtMs - now);
    if (quoteDelay > 0 && quoteAtMs > now) {
        const t1 = setTimeout(() => {
            postNeutralQuotes(market).catch(err =>
                logger.error(`CMM: postNeutralQuotes error — ${err.message}`)
            );
        }, quoteDelay);
        timers.push(t1);
    }

    // Check signal and skew at T-skewOffset
    const skewAtMs = slotEnd - skewOffsetMs;
    const skewDelay = Math.max(0, skewAtMs - now);
    if (skewDelay > 0 && skewAtMs > now) {
        const t2 = setTimeout(() => {
            checkSignalAndSkew(market).catch(err =>
                logger.error(`CMM: checkSignalAndSkew error — ${err.message}`)
            );
        }, skewDelay);
        timers.push(t2);
    }

    // Cancel all orders at T-cleanupOffset
    const cleanupAtMs = slotEnd - cleanupOffsetMs;
    const cleanupDelay = Math.max(0, cleanupAtMs - now);
    if (cleanupDelay > 0 && cleanupAtMs > now) {
        const t3 = setTimeout(() => {
            cleanupMarket(market.conditionId).catch(err =>
                logger.error(`CMM: cleanupMarket error — ${err.message}`)
            );
        }, cleanupDelay);
        timers.push(t3);
    }

    _pendingMarkets.set(key, { timers, market });
    scheduleOutcomeCheck(market);

    const tfLabel = SLOT_DURATION_LABEL[slotDuration] || `${slotDuration}s`;
    logger.info(
        `CMM: ${market.asset.toUpperCase()} [${tfLabel}] scheduled — quotes in ${Math.round(quoteDelay / 1000)}s, ` +
        `skew in ${Math.round(skewDelay / 1000)}s, cleanup in ${Math.round(cleanupDelay / 1000)}s`
    );
}

// ── Public API ──────────────────────────────────────────────────────────────

export function isDailyLossHit() {
    resetDailyLossIfNeeded();
    return _stats.dailyPnl <= -CMM_MAX_DAILY_LOSS;
}

export function getMMStats() {
    return {
        ..._stats,
        activeMarkets: _activeOrders.size,
        pendingMarkets: _pendingMarkets.size,
        paperBalance: PAPER_MODE ? _paper.balance : null,
    };
}

export function getActiveMarketCount() {
    return _activeOrders.size + _pendingMarkets.size;
}

export async function cancelAllOrders() {
    if (!PAPER_MODE) {
        // Cancel ALL open orders on the wallet — catches stale orders from previous sessions
        try {
            const client = getClient();
            await client.cancelAll();
            logger.info('CMM: cancelAll() completed — all open orders cancelled');
        } catch (err) {
            logger.warn(`CMM: cancelAll() failed — ${err.message}`);
        }
    }

    _activeOrders.clear();

    // Clear pending timers
    for (const [, { timers }] of _pendingMarkets) {
        for (const t of timers) clearTimeout(t);
    }
    _pendingMarkets.clear();

    logger.info('CMM: all orders cancelled and timers cleared');
}

export { CMM_ASSETS };
