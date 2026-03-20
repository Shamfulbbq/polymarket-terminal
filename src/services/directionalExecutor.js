/**
 * directionalExecutor.js
 * Waits for the signal window to elapse, reads Binance candles,
 * computes a directional signal, and places a single-side BUY order
 * on the predicted side of a BTC 15-minute Polymarket market.
 *
 * Includes orderbook pre-check (skip if unfillable) and Polymarket
 * fee calculation for accurate PnL tracking.
 */

import { Side, OrderType } from '@polymarket/clob-client';
import config from '../config/index.js';
import { getClient, getUsdcBalance } from './client.js';
import { getCandlesSince, getOrderFlowSince, getBinanceFeedStatus } from './binanceFeed.js';
import { ALL_SIGNALS } from '../backtest/signals.js';
import { submitOrderTimed } from './client.js';
import logger from '../utils/logger.js';
import { logBalance } from '../utils/balanceLedger.js';
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

const pendingTimers = new Map();
const activeTrades = [];

export function getActiveTrades() {
    return [...activeTrades];
}

export function getPendingCount() {
    return pendingTimers.size;
}

/**
 * Called when a new 15-minute market is detected.
 * Schedules signal evaluation after SIGNAL_MINUTES.
 */
export function scheduleDirectionalTrade(market) {
    const openAtMs = market.eventStartTime
        ? new Date(market.eventStartTime).getTime()
        : market.slotTimestamp * 1000;

    // Add 5s buffer past the signal window so the last 1m candle has time to close
    // and arrive via Binance WebSocket before we read the buffer
    const CANDLE_CLOSE_BUFFER_MS = 5_000;
    const signalAtMs = openAtMs + config.directionalSignalMinutes * 60_000 + CANDLE_CLOSE_BUFFER_MS;
    const delayMs = Math.max(0, signalAtMs - Date.now());

    // Time-of-day filter — skip UTC hours with historically negative PnL
    if (config.directionalBlockedHours.length > 0) {
        const signalHourUtc = new Date(signalAtMs).getUTCHours();
        if (config.directionalBlockedHours.includes(signalHourUtc)) {
            logger.info(
                `DIRECTIONAL: skipping "${market.question.slice(0, 40)}" — UTC hour ${signalHourUtc} is blocked`
            );
            return;
        }
    }

    const key = `${market.asset}-${market.slotTimestamp}`;

    if (pendingTimers.has(key)) return;

    logger.info(
        `DIRECTIONAL: scheduled signal check for "${market.question.slice(0, 40)}" in ${Math.round(delayMs / 1000)}s`
    );

    const timer = setTimeout(() => {
        pendingTimers.delete(key);
        evaluateAndTrade(market, openAtMs).catch((err) =>
            logger.error(`DIRECTIONAL: trade error — ${err.message}`)
        );
    }, delayMs);

    pendingTimers.set(key, timer);
}

async function evaluateAndTrade(market, openAtMs) {
    const { conditionId, question, yesTokenId, noTokenId, tickSize, negRisk, asset } = market;
    const label = question.slice(0, 40);

    // Get candles from Binance since market open
    const candles = getCandlesSince(openAtMs);

    if (candles.length < config.directionalSignalMinutes) {
        logger.warn(
            `DIRECTIONAL: only ${candles.length} candles available (need ${config.directionalSignalMinutes}) — skipping "${label}"`
        );
        logTrade(market, null, 'skipped', 'insufficient_candles');
        return;
    }

    // Run signal
    const signalFn = ALL_SIGNALS[config.directionalSignal];
    if (!signalFn) {
        logger.error(`DIRECTIONAL: unknown signal "${config.directionalSignal}"`);
        return;
    }

    const signalCandles = candles.slice(0, config.directionalSignalMinutes);
    const orderFlow = getOrderFlowSince(openAtMs);
    const { direction, confidence } = signalFn(signalCandles, { orderFlow });

    if (!direction) {
        logger.info(`DIRECTIONAL: no signal for "${label}" — skipping`);
        logTrade(market, null, 'skipped', 'no_signal');
        return;
    }

    if (config.directionalMinConfidence > 0 && confidence < config.directionalMinConfidence) {
        logger.info(
            `DIRECTIONAL: ${direction} signal too weak (${(confidence * 100).toFixed(1)}% < ${(config.directionalMinConfidence * 100).toFixed(0)}% min) — skipping "${label}"`
        );
        logTrade(market, direction, 'skipped', 'low_confidence', null, confidence, null, orderFlow);
        return;
    }

    // Determine which side to buy
    const tokenId = direction === 'UP' ? yesTokenId : noTokenId;
    const sideName = direction === 'UP' ? 'UP (YES)' : 'DOWN (NO)';

    // Orderbook pre-check — fetch live best ask for the target token
    const book = await fetchOrderbook(tokenId);
    const entryPrice = config.directionalEntryPrice;
    let effectivePrice = entryPrice;

    if (book) {
        const feeShares = computeFeeShares(config.directionalShares, entryPrice);
        const netPayout = computeNetPayout(config.directionalShares, entryPrice);
        const netProfit = netPayout - (entryPrice * config.directionalShares);

        const flowInfo = orderFlow.tradeCount > 0
            ? ` | OBI=${orderFlow.obiAvg?.toFixed(2)} CVD=${orderFlow.cvd?.toFixed(2)} ticks=${orderFlow.tradeCount}`
            : '';
        logger.trade(
            `DIRECTIONAL: signal=${direction} (${(confidence * 100).toFixed(0)}% conf) for "${label}" | ` +
            `bestAsk=$${book.bestAsk.toFixed(2)} spread=${book.spread.toFixed(3)} liq=${book.askLiquidity.toFixed(0)}sh${flowInfo}`
        );

        // If best ask is way above our limit, the order won't fill
        if (book.bestAsk > entryPrice + 0.05) {
            logger.warn(
                `DIRECTIONAL: best ask $${book.bestAsk.toFixed(2)} is >5c above limit $${entryPrice} — skipping "${label}"`
            );
            logTrade(market, direction, 'skipped', 'orderbook_unfillable', null, confidence, book, orderFlow);
            return;
        }

        logger.info(
            `DIRECTIONAL: fee=${feeShares.toFixed(3)}sh | net payout if win=$${netPayout.toFixed(2)} | net profit=$${netProfit.toFixed(2)}`
        );
    } else {
        logger.trade(
            `DIRECTIONAL: signal=${direction} (${(confidence * 100).toFixed(0)}% conf) for "${label}" | orderbook unavailable`
        );
    }

    // Balance check
    const cost = effectivePrice * config.directionalShares;
    if (!config.dryRun) {
        try {
            const balance = await getUsdcBalance();
            if (balance < cost) {
                logger.warn(`DIRECTIONAL: insufficient balance $${balance.toFixed(2)} < $${cost.toFixed(2)} — skipping`);
                logTrade(market, direction, 'skipped', 'insufficient_balance', null, confidence, book, orderFlow);
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
        logTrade(market, direction, 'placed', null, orderId, confidence, book, orderFlow);
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
            logTrade(market, direction, 'placed', null, res.orderID, confidence, book, orderFlow);
            logBalance('directional_order', { direction, orderId: res.orderID, cost }).catch(() => {});
        } else {
            const errMsg = res?.errorMsg || res?.message || 'unknown';
            logger.warn(`DIRECTIONAL: order failed — ${errMsg}`);
            logTrade(market, direction, 'failed', errMsg, null, confidence, book, orderFlow);
        }
    } catch (err) {
        logger.error(`DIRECTIONAL: order error — ${err.message}`);
        logTrade(market, direction, 'error', err.message, null, confidence, book, orderFlow);
    }
}

function logTrade(market, direction, status, reason, orderId, confidence, book, flow) {
    const price = config.directionalEntryPrice;
    const shares = config.directionalShares;
    const fee = computeFeeShares(shares, price);
    appendOrder({
        ts: new Date().toISOString(),
        conditionId: market.conditionId,
        asset: (market.asset || '').toUpperCase(),
        question: (market.question || '').slice(0, 200),
        signal: config.directionalSignal,
        signalMinutes: config.directionalSignalMinutes,
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
        bestAsk: book?.bestAsk ?? null,
        bestBid: book?.bestBid ?? null,
        spread: book?.spread ?? null,
        askLiquidity: book?.askLiquidity ?? null,
        obi: flow?.obiAvg ?? null,
        cvd: flow?.cvd ?? null,
        flowTrades: flow?.tradeCount ?? null,
    });
}

export function cancelAllPending() {
    for (const [key, timer] of pendingTimers) {
        clearTimeout(timer);
    }
    pendingTimers.clear();
}
