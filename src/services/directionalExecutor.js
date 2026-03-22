/**
 * directionalExecutor.js
 * Waits for the signal window to elapse, reads Binance candles,
 * computes a directional signal, and places a single-side BUY order
 * on the predicted side of a BTC Polymarket market.
 *
 * V2 additions:
 *   - Daily loss limit (DIRECTIONAL_DAILY_LOSS_LIMIT, default $10)
 *   - Max entry price cap (DIRECTIONAL_MAX_ENTRY_PRICE, default $0.60)
 *   - Timeframe-aware signal timing (15m vs 1H+)
 *   - Pre-market momentum via getCandlesBefore
 *   - Funding rate fetched at signal time
 */

import { Side, OrderType } from '@polymarket/clob-client';
import config from '../config/index.js';
import { getClient, getUsdcBalance } from './client.js';
import { getCandlesSince, getCandlesBefore, getOrderFlowSince, getBinanceFeedStatus, getBinanceFundingRate } from './binanceFeed.js';
import { ALL_SIGNALS } from '../backtest/signals.js';
import { submitOrderTimed } from './client.js';
import logger from '../utils/logger.js';
import { logBalance } from '../utils/balanceLedger.js';
import { validateOrderbook, isCircuitBroken } from '../utils/orderbookGuard.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'directional_orders.jsonl');

// Polymarket fee: fee_shares = shares * 0.25 * (price * (1 - price))^2
// Max ~1.56% at price=0.50, approaches 0 near 0 or 1
function computeFeeShares(shares, price) {
    return shares * 0.25 * Math.pow(price * (1 - price), 2);
}

function computeNetPayout(shares, price) {
    const feeShares = computeFeeShares(shares, price);
    return (shares - feeShares) * 1.0;
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

        // bids: ascending — best bid is the last one
        const bestBid = bids.length > 0 ? parseFloat(bids[bids.length - 1].price) : 0;
        // asks: descending — best ask (lowest) is the last one
        const bestAsk = asks.length > 0 ? parseFloat(asks[asks.length - 1].price) : 1;
        const spread = Math.round((bestAsk - bestBid) * 10000) / 10000;
        const askLiquidity = asks.reduce((sum, a) => sum + parseFloat(a.size || 0), 0);

        return { bestBid, bestAsk, spread, askLiquidity, bidCount: bids.length, askCount: asks.length };
    } catch {
        return null;
    }
}

function appendOrder(obj) {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    try {
        fs.appendFileSync(ORDERS_FILE, JSON.stringify(obj) + '\n', 'utf-8');
    } catch (err) {
        logger.error(`directionalExecutor: log write failed — ${err.message}`);
    }
}

// ── Daily loss limit ──────────────────────────────────────────────────────────
// Tracks cumulative trade cost placed today (UTC). Resets at midnight.
// Conservative: counts spend even on wins (since we don't know outcome yet).

let _dailyDate = new Date().toUTCString().slice(0, 11); // e.g. "22 Mar 2026"
let _dailySpend = 0;

function getDailySpend() {
    const today = new Date().toUTCString().slice(0, 11);
    if (today !== _dailyDate) {
        _dailyDate = today;
        _dailySpend = 0;
    }
    return _dailySpend;
}

function addDailySpend(amount) {
    getDailySpend(); // trigger reset if new day
    _dailySpend += amount;
}

export function getDailySpendTotal() {
    return getDailySpend();
}

// ── State ─────────────────────────────────────────────────────────────────────

const pendingTimers = new Map();
const activeTrades = [];

export function getActiveTrades() {
    return [...activeTrades];
}

export function getPendingCount() {
    return pendingTimers.size;
}

// ── Scheduling ────────────────────────────────────────────────────────────────

/**
 * Called when a new market is detected (15m or 1H+).
 * Schedules signal evaluation after the appropriate signal window.
 */
export function scheduleDirectionalTrade(market) {
    const openAtMs = market.eventStartTime
        ? new Date(market.eventStartTime).getTime()
        : market.slotTimestamp * 1000;

    // Pick signal window based on timeframe
    const slotDuration = market.slotDuration || 900; // seconds
    const signalMinutes = slotDuration >= 3600
        ? config.directional1hSignalMinutes
        : config.directionalSignalMinutes;

    // For instant signal (0 min), use a minimal buffer; otherwise add 5s for candle close
    const CANDLE_CLOSE_BUFFER_MS = signalMinutes > 0 ? 5_000 : 1_000;
    const signalAtMs = openAtMs + signalMinutes * 60_000 + CANDLE_CLOSE_BUFFER_MS;

    // Check there's enough time in the market after signalling (need ≥30s to be worth placing)
    const endAtMs = market.endTime
        ? new Date(market.endTime).getTime()
        : openAtMs + slotDuration * 1000;

    if (signalAtMs >= endAtMs - 30_000) {
        logger.info(
            `DIRECTIONAL: not enough time for ${signalMinutes}min signal on "${(market.question || '').slice(0, 40)}" — skipping`
        );
        return;
    }

    const delayMs = Math.max(0, signalAtMs - Date.now());

    // Time-of-day filter — skip UTC hours with historically negative PnL
    if (config.directionalBlockedHours.length > 0) {
        const signalHourUtc = new Date(signalAtMs).getUTCHours();
        if (config.directionalBlockedHours.includes(signalHourUtc)) {
            logger.info(
                `DIRECTIONAL: skipping "${(market.question || '').slice(0, 40)}" — UTC hour ${signalHourUtc} is blocked`
            );
            return;
        }
    }

    const key = `${market.asset}-${market.slotTimestamp}`;
    if (pendingTimers.has(key)) return;

    const timeframeLabel = slotDuration >= 3600 ? `${slotDuration / 3600}h` : '15m';
    logger.info(
        `DIRECTIONAL: scheduled ${timeframeLabel} signal for "${(market.question || '').slice(0, 40)}" in ${Math.round(delayMs / 1000)}s`
    );

    const timer = setTimeout(() => {
        pendingTimers.delete(key);
        evaluateAndTrade(market, openAtMs, signalMinutes).catch((err) =>
            logger.error(`DIRECTIONAL: trade error — ${err.message}`)
        );
    }, delayMs);

    pendingTimers.set(key, timer);
}

// ── Signal evaluation ─────────────────────────────────────────────────────────

async function evaluateAndTrade(market, openAtMs, signalMinutes) {
    const { conditionId, question, yesTokenId, noTokenId, tickSize, negRisk, asset, slotDuration } = market;
    const label = (question || '').slice(0, 40);
    const timeframeLabel = (slotDuration || 900) >= 3600 ? `${(slotDuration || 3600) / 3600}h` : '15m';

    // Circuit breaker check
    if (isCircuitBroken()) {
        logger.warn(`DIRECTIONAL: circuit breaker active — skipping "${label}"`);
        return;
    }

    // Get candles from Binance since market open
    const candles = getCandlesSince(openAtMs);

    if (signalMinutes > 0 && candles.length < signalMinutes) {
        logger.warn(
            `DIRECTIONAL: only ${candles.length} candles available (need ${signalMinutes}) — skipping "${label}"`
        );
        logTrade(market, null, 'skipped', 'insufficient_candles', null, null, null, null, { signalMinutes });
        return;
    }

    // Pre-market candles (5 min before open) — used by preMomentumComposite
    const preCandles = getCandlesBefore(openAtMs, 5);

    // Fetch funding rate in parallel with orderbook (best effort, non-blocking)
    const [fundingRate] = await Promise.allSettled([getBinanceFundingRate()]).then(
        (results) => results.map((r) => (r.status === 'fulfilled' ? r.value : null))
    );

    // Run signal
    const signalFn = ALL_SIGNALS[config.directionalSignal];
    if (!signalFn) {
        logger.error(`DIRECTIONAL: unknown signal "${config.directionalSignal}"`);
        return;
    }

    const signalCandles = signalMinutes > 0 ? candles.slice(0, signalMinutes) : [];
    const orderFlow = getOrderFlowSince(openAtMs);
    const { direction, confidence } = signalFn(signalCandles, { orderFlow, preCandles, fundingRate });

    if (!direction) {
        logger.info(`DIRECTIONAL: no signal for "${label}" (${timeframeLabel}) — skipping`);
        logTrade(market, null, 'skipped', 'no_signal', null, null, null, orderFlow, { signalMinutes });
        return;
    }

    if (config.directionalMinConfidence > 0 && confidence < config.directionalMinConfidence) {
        logger.info(
            `DIRECTIONAL: ${direction} signal too weak (${(confidence * 100).toFixed(1)}% < ${(config.directionalMinConfidence * 100).toFixed(0)}% min) — skipping "${label}"`
        );
        logTrade(market, direction, 'skipped', 'low_confidence', null, confidence, null, orderFlow, { signalMinutes });
        return;
    }

    // Determine which side to buy
    const tokenId = direction === 'UP' ? yesTokenId : noTokenId;
    const sideName = direction === 'UP' ? 'UP (YES)' : 'DOWN (NO)';

    // Hard max entry price cap (V2 safety)
    const entryPrice = config.directionalEntryPrice;
    if (entryPrice > config.directionalMaxEntryPrice) {
        logger.warn(
            `DIRECTIONAL: entry price $${entryPrice} exceeds max cap $${config.directionalMaxEntryPrice} — skipping "${label}"`
        );
        logTrade(market, direction, 'skipped', 'max_entry_price', null, confidence, null, orderFlow, { signalMinutes });
        return;
    }

    const cost = entryPrice * config.directionalShares;

    // Daily loss limit check (V2 safety)
    const dailyLimit = config.directionalDailyLossLimit;
    if (dailyLimit > 0) {
        const spent = getDailySpend();
        if (spent + cost > dailyLimit) {
            logger.warn(
                `DIRECTIONAL: daily limit $${dailyLimit} reached ($${spent.toFixed(2)} spent today) — skipping "${label}"`
            );
            logTrade(market, direction, 'skipped', 'daily_limit', null, confidence, null, orderFlow, { signalMinutes });
            return;
        }
    }

    // Orderbook pre-check — fetch live best ask for the target token
    const book = validateOrderbook(tokenId, await fetchOrderbook(tokenId));
    const effectivePrice = entryPrice;

    if (book) {
        const feeShares = computeFeeShares(config.directionalShares, effectivePrice);
        const netPayout = computeNetPayout(config.directionalShares, effectivePrice);
        const netProfit = netPayout - cost;

        const fundingStr = fundingRate != null ? ` | funding=${fundingRate > 0 ? '+' : ''}${fundingRate.toFixed(4)}` : '';
        const preMomStr = preCandles.length >= 2
            ? ` | pre=${preCandles.length}c(${((preCandles[preCandles.length - 1].close - preCandles[0].open) / preCandles[0].open * 100).toFixed(2)}%)`
            : '';
        const flowInfo = orderFlow.tradeCount > 0
            ? ` | OBI=${orderFlow.obiAvg?.toFixed(2)} CVD=${orderFlow.cvd?.toFixed(2)} ticks=${orderFlow.tradeCount}`
            : '';
        logger.trade(
            `DIRECTIONAL[${timeframeLabel}]: signal=${direction} (${(confidence * 100).toFixed(0)}% conf) for "${label}" | ` +
            `bestAsk=$${book.bestAsk.toFixed(2)} spread=${book.spread.toFixed(3)} liq=${book.askLiquidity.toFixed(0)}sh${flowInfo}${preMomStr}${fundingStr}`
        );

        // If best ask is way above our limit, the order won't fill
        if (book.bestAsk > effectivePrice + 0.05) {
            logger.warn(
                `DIRECTIONAL: best ask $${book.bestAsk.toFixed(2)} is >5c above limit $${effectivePrice} — skipping "${label}"`
            );
            logTrade(market, direction, 'skipped', 'orderbook_unfillable', null, confidence, book, orderFlow, { signalMinutes });
            return;
        }

        logger.info(
            `DIRECTIONAL: fee=${feeShares.toFixed(3)}sh | net payout if win=$${netPayout.toFixed(2)} | net profit=$${netProfit.toFixed(2)}`
        );
    } else {
        logger.trade(
            `DIRECTIONAL[${timeframeLabel}]: signal=${direction} (${(confidence * 100).toFixed(0)}% conf) for "${label}" | orderbook unavailable`
        );
    }

    // Balance check
    if (!config.dryRun) {
        try {
            const balance = await getUsdcBalance();
            if (balance < cost) {
                logger.warn(`DIRECTIONAL: insufficient balance $${balance.toFixed(2)} < $${cost.toFixed(2)} — skipping`);
                logTrade(market, direction, 'skipped', 'insufficient_balance', null, confidence, book, orderFlow, { signalMinutes });
                return;
            }
        } catch { /* proceed anyway, order will fail if no balance */ }
    }

    // Fee-adjusted metrics for logging
    const feeShares = computeFeeShares(config.directionalShares, effectivePrice);
    const netPayout = computeNetPayout(config.directionalShares, effectivePrice);

    if (config.dryRun) {
        const orderId = `sim-dir-${Date.now()}-${tokenId.slice(-6)}`;
        logger.money(
            `DIRECTIONAL[SIM]: BUY ${sideName} @ $${effectivePrice} × ${config.directionalShares}sh | cost $${cost.toFixed(2)} | net payout $${netPayout.toFixed(2)} | "${label}"`
        );
        const rec = {
            asset: asset.toUpperCase(),
            direction,
            side: sideName,
            orderId,
            price: effectivePrice,
            shares: config.directionalShares,
            cost,
            confidence,
            feeShares: Math.round(feeShares * 10000) / 10000,
            potentialPayout: Math.round(netPayout * 100) / 100,
        };
        activeTrades.push(rec);
        addDailySpend(cost);
        logTrade(market, direction, 'placed', null, orderId, confidence, book, orderFlow, { signalMinutes, fundingRate });
        return;
    }

    // Live order
    try {
        const { res, timing } = await submitOrderTimed(
            {
                tokenID: tokenId,
                side: Side.BUY,
                price: effectivePrice,
                size: config.directionalShares,
            },
            { tickSize, negRisk },
            OrderType.GTC,
        );

        if (res?.success) {
            logger.money(
                `DIRECTIONAL: BUY ${sideName} @ $${effectivePrice} × ${config.directionalShares}sh | ` +
                `net payout $${netPayout.toFixed(2)} | order ${res.orderID} | "${label}"`
            );
            activeTrades.push({
                asset: asset.toUpperCase(),
                direction,
                side: sideName,
                orderId: res.orderID,
                price: effectivePrice,
                shares: config.directionalShares,
                cost,
                confidence,
                feeShares: Math.round(feeShares * 10000) / 10000,
                potentialPayout: Math.round(netPayout * 100) / 100,
            });
            addDailySpend(cost);
            logTrade(market, direction, 'placed', null, res.orderID, confidence, book, orderFlow, { signalMinutes, fundingRate });
            logBalance('directional_order', { direction, orderId: res.orderID, cost }).catch(() => {});
        } else {
            const errMsg = res?.errorMsg || res?.message || 'unknown';
            logger.warn(`DIRECTIONAL: order failed — ${errMsg}`);
            logTrade(market, direction, 'failed', errMsg, null, confidence, book, orderFlow, { signalMinutes });
        }
    } catch (err) {
        logger.error(`DIRECTIONAL: order error — ${err.message}`);
        logTrade(market, direction, 'error', err.message, null, confidence, book, orderFlow, { signalMinutes });
    }
}

function logTrade(market, direction, status, reason, orderId, confidence, book, flow, meta = {}) {
    const price = config.directionalEntryPrice;
    const shares = config.directionalShares;
    const fee = computeFeeShares(shares, price);
    appendOrder({
        ts: new Date().toISOString(),
        conditionId: market.conditionId,
        asset: (market.asset || '').toUpperCase(),
        question: (market.question || '').slice(0, 200),
        signal: config.directionalSignal,
        signalMinutes: meta.signalMinutes ?? config.directionalSignalMinutes,
        slotDuration: market.slotDuration || 900,
        direction: direction || null,
        status,
        reason: reason || null,
        orderId: orderId || null,
        price,
        shares,
        cost: price * shares,
        feeShares: Math.round(fee * 10000) / 10000,
        netPayoutIfWin: Math.round(computeNetPayout(shares, price) * 100) / 100,
        confidence: confidence ?? null,
        fundingRate: meta.fundingRate ?? null,
        bestAsk: book?.bestAsk ?? null,
        bestBid: book?.bestBid ?? null,
        spread: book?.spread ?? null,
        askLiquidity: book?.askLiquidity ?? null,
        obi: flow?.obiAvg ?? null,
        cvd: flow?.cvd ?? null,
        flowTrades: flow?.tradeCount ?? null,
        dailySpend: getDailySpend(),
    });
}

export function cancelAllPending() {
    for (const [key, timer] of pendingTimers) {
        clearTimeout(timer);
    }
    pendingTimers.clear();
}
