/**
 * cryptoMMExecutor.js
 * Directional signal executor for Polymarket crypto markets.
 * Waits for ML-gated signal, then places a single BUY on the predicted winner side.
 * Supports 5-minute, 15-minute, 1H, and 4H markets via slotDuration-derived timing.
 *
 * Timeline per market (proportional to slotDuration):
 *   T-(25%): CHECK signal + ML filter -> BUY predicted winner if approved
 *   T-10s/60s: CANCEL unfilled orders before resolution
 *   T+3min:    CHECK outcome, compute PnL
 */

import { Side, OrderType } from '@polymarket/clob-client';
import config from '../config/index.js';
import { getClient, submitOrderTimed } from './client.js';
import { getCandlesSince, getOrderFlowSince, getBinanceFundingRate, getBinanceFundingHistory, getBinanceLongShortRatio } from './binanceFeed.js';
import { checkResolutionOnChain } from './ctf.js';
import { validateOrderbook, isCircuitBroken } from '../utils/orderbookGuard.js';
import logger from '../utils/logger.js';
import { computeFee, getRebateRate } from './feeSchedule.js';
import { evaluate as evaluateSignal, loadSignalModels, checkModelDegradation } from './cmmSignal.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const LOG_FILE = path.join(DATA_DIR, 'crypto_mm.jsonl');
const STATE_FILE = path.join(DATA_DIR, 'cmm_state.json');

// ── Configuration (from environment) ────────────────────────────────────────

const CMM_ASSETS = (process.env.CMM_ASSETS || 'btc,eth,sol').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const CMM_SKEW_SPREAD = parseFloat(process.env.CMM_SKEW_SPREAD || '0.02');
const CMM_MAX_DAILY_LOSS = parseFloat(process.env.CMM_MAX_DAILY_LOSS || '50');
const CMM_SIGNAL_MINUTES = parseInt(process.env.CMM_SIGNAL_MINUTES || '3', 10);

const SLOT_SEC = 5 * 60; // default / fallback
const PAPER_MODE = config.dryRun;

// Wallet address used for getTrades fill detection
const CMM_MAKER_ADDRESS = config.tailSweepProxyWallet || config.proxyWallet;

// Slug label lookup by slot duration (for checkOutcome)
const SLOT_DURATION_LABEL = { 300: '5m', 900: '15m', 3600: '1h', 14400: '4h', 86400: 'daily', 604800: 'weekly' };

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
    return computeFee(shares, price, 'crypto');
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
        saveState();
    }
}

// Signal logic (feature engineering, ML inference, sizing) moved to cmmSignal.js

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

// ── Signal evaluation + entry ───────────────────────────────────────────────

async function checkSignalAndEnter(market) {
    const { conditionId, yesTokenId, noTokenId, asset } = market;
    const label = `${asset.toUpperCase()} ${(market.question || '').slice(0, 30)}`;

    // Already entered this market — skip
    if (_activeOrders.has(conditionId)) return;

    if (isCircuitBroken()) {
        logger.warn(`CMM: ${label} — circuit breaker active, skipping entry`);
        return;
    }

    if (isDailyLossHit()) {
        logger.warn(`CMM: ${label} — daily loss limit hit, skipping entry`);
        return;
    }

    // Get Binance data since market open
    const openAtMs = market.eventStartTime
        ? new Date(market.eventStartTime).getTime()
        : market.slotTimestamp * 1000;

    const candles = getCandlesSince(openAtMs, asset);

    if (candles.length < CMM_SIGNAL_MINUTES) {
        logger.info(`CMM: ${label} — only ${candles.length} candles (need ${CMM_SIGNAL_MINUTES}), keeping neutral`);
        logAction('signal_skip', { conditionId, asset: asset.toUpperCase(), reason: 'insufficient_candles', candleCount: candles.length });
        return;
    }

    // Fetch orderbook for entry pricing
    const [rawYesBook, rawNoBook] = await Promise.all([
        fetchOrderbook(yesTokenId),
        fetchOrderbook(noTokenId),
    ]);
    const yesBook = validateOrderbook(yesTokenId, rawYesBook);
    const noBook  = validateOrderbook(noTokenId,  rawNoBook);
    if (!yesBook || !noBook) {
        logger.warn(`CMM: ${label} — orderbook unavailable at signal time, skipping entry`);
        return;
    }
    const yesMid = (yesBook.bestBid + yesBook.bestAsk) / 2;
    const noMid  = (noBook.bestBid  + noBook.bestAsk)  / 2;

    // Fetch live Binance data for signal module (all best-effort, fail to defaults)
    const orderFlow = getOrderFlowSince(openAtMs, asset);
    const [fundingRate, fundingHistory, lsRatio] = await Promise.all([
        getBinanceFundingRate(asset).catch(() => null),
        getBinanceFundingHistory(asset, 20).catch(() => null),
        getBinanceLongShortRatio(asset).catch(() => null),
    ]);

    // Evaluate signal (feature engineering + ML filter + sizing)
    const signal = await evaluateSignal(asset, candles, orderFlow,
        { fundingRate, fundingHistory, lsRatio },
        { ...market, yesMid, noMid },
    );

    if (!signal) {
        logAction('signal_skip', { conditionId, asset: asset.toUpperCase(), reason: 'no_signal_or_filtered' });
        return;
    }

    const { direction, side: entrySide, shares: entryShares, modelScore, confidence, sizing } = signal;

    logger.info(
        `CMM: ${label} — signal=${direction} (${(sizing.safeConf * 100).toFixed(0)}% conf` +
        `${modelScore !== null ? ` score=${modelScore.toFixed(3)}` : ''}) ` +
        `tier=${sizing.tier}[${sizing.low.toFixed(2)}/${sizing.mid.toFixed(2)}/${sizing.high.toFixed(2)}] ` +
        `mult=${sizing.mult.toFixed(2)}× → ${entryShares}sh — entering`
    );

    // Directional entry: BUY the predicted winner side only.
    // Bid at mid - CMM_SKEW_SPREAD/2 (just inside mid; GTC, cancelled at cleanup if unfilled).
    const entryPrice = entrySide === 'YES'
        ? yesMid - CMM_SKEW_SPREAD / 2
        : noMid - CMM_SKEW_SPREAD / 2;
    const entryTokenId = entrySide === 'YES' ? yesTokenId : noTokenId;

    const entryOrderId = await placeOrder(market, entryTokenId, Side.BUY, entryPrice, entryShares, `${label} ${entrySide} BUY (signal ${direction})`);
    if (!entryOrderId) return;

    _activeOrders.set(conditionId, {
        yesBidId:  entrySide === 'YES' ? entryOrderId : null,
        yesAskId:  null,
        noBidId:   entrySide === 'NO'  ? entryOrderId : null,
        noAskId:   null,
        market, fills: [],
        yesMid, noMid,
        entrySide, entryPrice, entryShares,
        postedAt: Date.now(),
    });

    _stats.marketsQuoted++;

    logAction('signal_entry', {
        conditionId, asset: asset.toUpperCase(),
        direction, confidence,
        obi: orderFlow.obiAvg, cvd: orderFlow.cvd,
        slotDuration: market.slotDuration || SLOT_SEC,
        yesMid, entrySide, entryPrice, entryShares,
        kellyMultiplier: parseFloat(sizing.mult.toFixed(3)),
        sizeTier: sizing.tier,
        confBands: { low: sizing.low, mid: sizing.mid, high: sizing.high },
        ...(modelScore !== null && { modelScore: parseFloat(modelScore.toFixed(4)) }),
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

    // Paper mode: infer simulated fills by checking if market price crossed our quotes
    if (PAPER_MODE && orders.yesMid !== undefined) {
        await simulatePaperFills(conditionId, orders);
    }

    // Don't delete from _activeOrders yet — outcome check needs the fills
}

/**
 * Paper fill simulation: fetch final orderbook prices and infer whether
 * our bid/ask quotes would have been filled based on mid price movement.
 * Called at cleanup time (T-60s before resolution) in paper mode only.
 *
 * Logic: if market mid moved past our bid price → assume takers hit our bid.
 *        if market mid moved past our ask price → assume takers hit our ask.
 */
async function simulatePaperFills(conditionId, orders) {
    // Directional entry: the bot only holds a single BUY order (no neutral quotes).
    // Only count a fill if the market price has crossed the order's limit price.
    const { market, entrySide, entryPrice, entryShares } = orders;
    if (!entrySide || !entryPrice || !entryShares) return;

    const label = `${market.asset.toUpperCase()} [paper]`;
    const orderId = orders.yesBidId || orders.noBidId || 'paper-buy';
    const tokenId = entrySide === 'YES' ? market.yesTokenId : market.noTokenId;

    // Check if market price has crossed our limit — a BUY fills when ask <= our price
    const book = await fetchOrderbook(tokenId);
    if (book) {
        const bestAsk = book.bestAsk;
        if (bestAsk > entryPrice) {
            logger.info(`CMM[PAPER]: ${label} — BUY @ $${entryPrice.toFixed(2)} not filled (bestAsk=$${bestAsk.toFixed(2)} > limit)`);
            logAction('paper_fill_skip', {
                conditionId, asset: market.asset.toUpperCase(),
                entrySide, entryPrice, bestAsk, reason: 'price_not_crossed',
            });
            return;
        }
    }
    // If orderbook unavailable, assume fill (conservative — matches old behavior)

    handleFill(conditionId, orderId, entrySide, entryPrice, entryShares, true);
    logger.info(`CMM[PAPER]: ${label} — simulated ${entrySide} BUY fill @ $${entryPrice.toFixed(2)} x ${entryShares}sh`);

    // Track cost so PnL at outcome is correct (payout - cost)
    // Mark fill as cost-deducted to prevent double-counting in scheduleOutcomeCheck
    _stats.dailyPnl -= entryPrice * entryShares;
    const fills = _activeOrders.get(conditionId)?.fills;
    if (fills?.length) fills[fills.length - 1].costDeducted = true;

    logAction('paper_fill_simulation', {
        conditionId, asset: market.asset.toUpperCase(),
        entrySide, entryPrice, entryShares,
    });
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
            logger.warn(`CMM: ${label} — outcome unknown after 6 attempts, fills unresolved`);
            const tfLabel = SLOT_DURATION_LABEL[slotDuration] || `${slotDuration}s`;
            logAction('outcome', {
                conditionId, asset: asset.toUpperCase(),
                timeframe: tfLabel,
                outcome: 'UNKNOWN', fills: fills.length, marketPnl: null,
                dailyPnl: _stats.dailyPnl,
            });
            _activeOrders.delete(conditionId);
            for (const [key, entry] of _pendingMarkets) {
                if (entry.market.conditionId === conditionId) {
                    _pendingMarkets.delete(key);
                    break;
                }
            }
            return;
        }

        // Compute PnL from fills.
        // BUY fills with costDeducted: cost already subtracted from dailyPnl at fill time,
        //   so only credit the payout here (don't subtract cost again).
        // BUY fills without costDeducted: full PnL = payout - cost.
        // SELL fills: received price upfront; owe payout if our side won.
        let marketPnl = 0;
        for (const fill of fills) {
            const sideWon = (fill.side === 'YES' && outcome === 'UP') || (fill.side === 'NO' && outcome === 'DOWN');
            const feeShares = computeFeeShares(fill.shares, fill.price);
            let pnl;
            if (fill.buy) {
                if (fill.costDeducted) {
                    // Cost already deducted — just credit payout
                    pnl = sideWon ? (fill.shares - feeShares) : 0;
                } else {
                    // Cost not yet deducted — full PnL
                    pnl = sideWon ? (fill.shares - feeShares - fill.price * fill.shares) : -(fill.price * fill.shares);
                }
                if (sideWon) _stats.wins++;
                else _stats.losses++;
            } else {
                // Received price upfront; owe payout if our side won
                pnl = fill.price * fill.shares - (sideWon ? fill.shares : 0);
                if (!sideWon) _stats.wins++; // sold the losing side → good
                else _stats.losses++;
            }
            marketPnl += pnl;
        }

        resetDailyLossIfNeeded();
        _stats.dailyPnl += marketPnl;

        const pnlStr = marketPnl >= 0 ? `+$${marketPnl.toFixed(2)}` : `-$${Math.abs(marketPnl).toFixed(2)}`;
        const emoji = fills.length === 0 ? 'SKIP' : (marketPnl >= 0 ? 'WIN' : 'LOSS');
        logger.money(`CMM: ${emoji} ${label} — outcome=${outcome} fills=${fills.length} pnl=${pnlStr} | daily=$${_stats.dailyPnl.toFixed(2)}`);

        const tfLabel = SLOT_DURATION_LABEL[slotDuration] || `${slotDuration}s`;
        logAction('outcome', {
            conditionId, asset: asset.toUpperCase(),
            timeframe: tfLabel,
            outcome, fills: fills.length, marketPnl,
            dailyPnl: _stats.dailyPnl,
        });

        _activeOrders.delete(conditionId);
        saveState();

        // Remove from pending markets to prevent memory growth
        for (const [key, entry] of _pendingMarkets) {
            if (entry.market.conditionId === conditionId) {
                _pendingMarkets.delete(key);
                break;
            }
        }
    }, waitMs);

    logger.info(`CMM: outcome check scheduled in ${Math.round(waitMs / 1000)}s for ${market.asset.toUpperCase()}`);
}

// ── Fill handling ───────────────────────────────────────────────────────────

export function handleFill(conditionId, orderId, side, price, shares, buy) {
    const orders = _activeOrders.get(conditionId);
    if (!orders) return;

    orders.fills.push({ orderId, side, price, shares, buy, costDeducted: false, ts: Date.now() });
    _stats.fills++;

    const label = `${orders.market.asset.toUpperCase()}`;
    const fee = computeFeeShares(shares, price);
    const rebateRate = getRebateRate('crypto');
    _stats.dailyFeesSaved += fee * rebateRate; // maker rebate estimate

    logger.info(`CMM: FILL ${label} ${side} @ $${price.toFixed(2)} x ${shares}sh — fee=${fee.toFixed(3)}sh rebate=$${(fee * rebateRate).toFixed(3)}`);

    logAction('fill', { conditionId, asset: label, side, price, shares, orderId, fillPrice: price });
}

// ── Fill detection loop ─────────────────────────────────────────────────────

const _processedFills = new Set(); // trade IDs already processed

// ── State persistence ──────────────────────────────────────────────────────

function saveState() {
    try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        const state = {
            date: new Date().toISOString().slice(0, 10),
            stats: { ..._stats },
            processedFills: [..._processedFills],
            savedAt: new Date().toISOString(),
        };
        fs.writeFileSync(STATE_FILE, JSON.stringify(state) + '\n', 'utf-8');
    } catch (err) {
        logger.warn(`CMM: state save failed — ${err.message}`);
    }
}

function loadState() {
    try {
        if (!fs.existsSync(STATE_FILE)) return;
        const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
        const today = new Date().toISOString().slice(0, 10);
        if (raw.date !== today) {
            logger.info('CMM: stale state file (different day) — starting fresh');
            return;
        }
        if (raw.stats) {
            _stats.marketsQuoted = raw.stats.marketsQuoted || 0;
            _stats.fills = raw.stats.fills || 0;
            _stats.wins = raw.stats.wins || 0;
            _stats.losses = raw.stats.losses || 0;
            _stats.dailyPnl = raw.stats.dailyPnl || 0;
            _stats.dailyRewardEstimate = raw.stats.dailyRewardEstimate || 0;
            _stats.dailyFeesSaved = raw.stats.dailyFeesSaved || 0;
        }
        if (Array.isArray(raw.processedFills)) {
            for (const id of raw.processedFills) _processedFills.add(id);
        }
        logger.info(`CMM: restored state — fills=${_stats.fills} W=${_stats.wins} L=${_stats.losses} daily=$${_stats.dailyPnl.toFixed(2)} processedFills=${_processedFills.size}`);
    } catch (err) {
        logger.warn(`CMM: state load failed — ${err.message}`);
    }
}

loadState();

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

        // API returns match_time (unix seconds) not created_at (ISO)
        const tradeTs = trade.match_time ? parseInt(trade.match_time) * 1000
            : (trade.created_at ? new Date(trade.created_at).getTime() : 0);
        if (tradeTs < cutoffMs) continue;

        // API returns "market" field, not "condition_id"
        const conditionId = trade.market || trade.condition_id;
        const orders = _activeOrders.get(conditionId);
        if (!orders) continue; // not an active CMM market — skip

        // Find our specific maker order in the maker_orders array
        const ourMakerOrder = Array.isArray(trade.maker_orders)
            ? trade.maker_orders.find(mo =>
                mo.maker_address?.toLowerCase() === CMM_MAKER_ADDRESS.toLowerCase())
            : null;
        if (!ourMakerOrder) continue; // we weren't a maker in this trade

        _processedFills.add(tradeId);

        const price = parseFloat(ourMakerOrder.price || trade.price || '0');
        const shares = parseFloat(ourMakerOrder.matched_amount || trade.size || '0');
        if (shares <= 0) continue;

        // Our maker order's side tells us directly what we did
        const ourSide = (ourMakerOrder.side || '').toUpperCase();
        const weAreBuying = ourSide === 'BUY';

        // Determine YES vs NO by matching asset_id to the market's token IDs
        const assetId = ourMakerOrder.asset_id || trade.asset_id || trade.token_id;
        const isYes = assetId === orders.market.yesTokenId;
        const isNo = assetId === orders.market.noTokenId;
        if (!isYes && !isNo) {
            logger.warn(`CMM: unknown token ID ${assetId?.slice(0, 20)}... in fill — skipping`);
            _processedFills.delete(tradeId);
            continue;
        }
        const fillSide = isYes ? 'YES' : 'NO';

        const makerOrderId = ourMakerOrder.order_id || trade.maker_order_id;
        logger.money(`CMM: FILL ${fillSide} ${weAreBuying ? 'BUY' : 'SELL'} ${shares}sh @ $${price.toFixed(2)}`);
        handleFill(conditionId, makerOrderId, fillSide, price, shares, weAreBuying);

        // Pessimistic daily PnL: count BUY fills as cost until outcome resolves
        if (weAreBuying) {
            _stats.dailyPnl -= price * shares;
            const fills = _activeOrders.get(conditionId)?.fills;
            if (fills?.length) fills[fills.length - 1].costDeducted = true;
            if (isDailyLossHit()) {
                logger.error(`CMM: DAILY LOSS LIMIT HIT ($${_stats.dailyPnl.toFixed(2)}) — cancelling all orders`);
                await cancelAllOrders();
                return;
            }
        }
    }

    saveState();
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
    const { skewOffsetMs, cleanupOffsetMs } = getSlotTimings(slotDuration);

    // Check signal and enter at T-skewOffset (only action — no neutral quotes)
    const entryAtMs = slotEnd - skewOffsetMs;
    const entryDelay = Math.max(0, entryAtMs - now);
    if (entryDelay > 0 && entryAtMs > now) {
        const t1 = setTimeout(() => {
            checkSignalAndEnter(market).catch(err =>
                logger.error(`CMM: checkSignalAndEnter error — ${err.message}`)
            );
        }, entryDelay);
        timers.push(t1);
    }

    // Cancel any open orders at T-cleanupOffset
    const cleanupAtMs = slotEnd - cleanupOffsetMs;
    const cleanupDelay = Math.max(0, cleanupAtMs - now);
    if (cleanupDelay > 0 && cleanupAtMs > now) {
        const t2 = setTimeout(() => {
            cleanupMarket(market.conditionId).catch(err =>
                logger.error(`CMM: cleanupMarket error — ${err.message}`)
            );
        }, cleanupDelay);
        timers.push(t2);
    }

    _pendingMarkets.set(key, { timers, market });
    scheduleOutcomeCheck(market);

    const tfLabel = SLOT_DURATION_LABEL[slotDuration] || `${slotDuration}s`;
    logger.info(
        `CMM: ${market.asset.toUpperCase()} [${tfLabel}] scheduled — signal check in ${Math.round(entryDelay / 1000)}s, ` +
        `cleanup in ${Math.round(cleanupDelay / 1000)}s`
    );
}

// ── Public API ──────────────────────────────────────────────────────────────

export function isDailyLossHit() {
    if (PAPER_MODE) return false; // no loss limit in paper mode
    resetDailyLossIfNeeded();
    return _stats.dailyPnl <= -CMM_MAX_DAILY_LOSS;
}

export function getMMStats() {
    return {
        ..._stats,
        activeMarkets: _activeOrders.size,
        pendingMarkets: _pendingMarkets.size,
        paperBalance: PAPER_MODE ? _paper.balance : null,
        dailyLossHit: isDailyLossHit(),
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

export { CMM_ASSETS, loadSignalModels, saveState, checkModelDegradation };
