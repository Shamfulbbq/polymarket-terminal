/**
 * directionalExecutor.js
 */

import { Side, OrderType } from '@polymarket/clob-client';
import config from '../config/index.js';
import { getClient, getUsdcBalance } from './client.js';
import { 
    getCandlesSince, 
    getCandlesBefore, 
    getOrderFlowSince, 
    getBinanceFeedStatus, 
    getBinanceFundingRate 
} from './binanceFeed.js';
import { ALL_SIGNALS } from '../backtest/signals.js';
import { submitOrderTimed } from './client.js';
import logger from '../utils/logger.js';
import { logBalance, getBalancePnl } from '../utils/balanceLedger.js';
import { validateOrderbook, isCircuitBroken } from '../utils/orderbookGuard.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'directional_orders.jsonl');

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
        const bestBid = bids.length > 0 ? parseFloat(bids[bids.length - 1].price) : 0;
        const bestAsk = asks.length > 0 ? parseFloat(asks[asks.length - 1].price) : 1;
        const spread = Math.round((bestAsk - bestBid) * 10000) / 10000;
        const askLiquidity = asks.reduce((sum, a) => sum + parseFloat(a.size || 0), 0);
        return { bestBid, bestAsk, spread, askLiquidity, bidCount: bids.length, askCount: asks.length };
    } catch { return null; }
}

function appendOrder(obj) {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    try {
        fs.appendFileSync(ORDERS_FILE, JSON.stringify(obj) + '\n', 'utf-8');
    } catch (err) {
        logger.error(`directionalExecutor: log write failed — ${err.message}`);
    }
}

// ── State ─────────────────────────────────────────────────────────────────────
let _dailyDate = new Date().toUTCString().slice(0, 11);
let _dailySpend = 0;

function getDailySpend() {
    const today = new Date().toUTCString().slice(0, 11);
    if (today !== _dailyDate) { _dailyDate = today; _dailySpend = 0; }
    return _dailySpend;
}

function addDailySpend(amount) {
    getDailySpend();
    _dailySpend += amount;
}

export function getDailySpendTotal() { return getDailySpend(); }

const pendingTimers = new Map();
const activeTrades = [];

export function getActiveTrades() { return [...activeTrades]; }
export function getPendingCount() { return pendingTimers.size; }

// ── Scheduling ────────────────────────────────────────────────────────────────

export function scheduleDirectionalTrade(market) {
    const openAtMs = market.eventStartTime ? new Date(market.eventStartTime).getTime() : market.slotTimestamp * 1000;
    const slotDuration = market.slotDuration || 900;
    const signalMinutes = slotDuration >= 3600 ? config.directional1hSignalMinutes : config.directionalSignalMinutes;

    const signalAtMs = openAtMs + signalMinutes * 60_000 + (signalMinutes > 0 ? 5000 : 1000);
    const endAtMs = market.endTime ? new Date(market.endTime).getTime() : openAtMs + slotDuration * 1000;

    if (signalAtMs >= endAtMs - 30_000) return;

    if (config.directionalBlockedHours.length > 0) {
        const signalHourUtc = new Date(signalAtMs).getUTCHours();
        if (config.directionalBlockedHours.includes(signalHourUtc)) return;
    }

    const key = `${market.asset}-${market.slotTimestamp}`;
    if (pendingTimers.has(key)) return;

    logger.info(`DIRECTIONAL: scheduled ${market.asset} signal in ${Math.round((signalAtMs - Date.now()) / 1000)}s`);

    const timer = setTimeout(() => {
        pendingTimers.delete(key);
        evaluateAndTrade(market, openAtMs, signalMinutes).catch((err) =>
            logger.error(`DIRECTIONAL: trade error — ${err.message}`)
        );
    }, Math.max(0, signalAtMs - Date.now()));

    pendingTimers.set(key, timer);
}

// ── Signal evaluation ─────────────────────────────────────────────────────────

async function evaluateAndTrade(market, openAtMs, signalMinutes) {
    const { yesTokenId, noTokenId, tickSize, negRisk, asset } = market;
    const label = (market.question || '').slice(0, 40);

    if (isCircuitBroken()) return;

    const assetLower = (asset || '').toLowerCase();
    const overrides = config.directionalAssetOverrides?.[assetLower] || {};
    const activeSignal = overrides.signal || config.directionalSignal;
    const activeSignalMinutes = overrides.signalMinutes ?? signalMinutes;
    const activeSharesMax = overrides.shares ?? config.directionalShares;
    const activeEntryPriceInitial = overrides.entryPrice ?? config.directionalEntryPrice;
    const activeMinConfidence = overrides.minConfidence ?? config.directionalMinConfidence;

    const candles = getCandlesSince(assetLower, openAtMs);

    if (activeSignalMinutes > 0 && candles.length < activeSignalMinutes) {
        logTrade(market, { direction: null, confidence: 0, signal: activeSignal, signalMinutes: activeSignalMinutes }, 'skipped', 'insufficient_candles');
        return;
    }

    const preCandles = getCandlesBefore(assetLower, openAtMs, 5);
    const [fundingRate] = await Promise.allSettled([getBinanceFundingRate(assetLower)]).then(
        (results) => results.map((r) => (r.status === 'fulfilled' ? r.value : null))
    );

    const signalFn = ALL_SIGNALS[activeSignal];
    if (!signalFn) return;

    const signalCandles = activeSignalMinutes > 0 ? candles.slice(0, activeSignalMinutes) : [];
    const orderFlow = getOrderFlowSince(assetLower, openAtMs);
    const { direction, confidence, features, skipped: signalSkipped, skipReason: signalSkipReason } = signalFn(signalCandles, { orderFlow, preCandles, fundingRate });

    const predictionLog = {
        direction: direction || null,
        confidence: confidence || 0,
        features: features || {},
        signal: activeSignal,
        signalMinutes: activeSignalMinutes
    };

    // 🔴 HIGH: Fix issue #1 - Explicitly respect signal skipped flag
    if (signalSkipped) {
        logger.info(`DIRECTIONAL: signal skipped (${signalSkipReason}) for "${label}"`);
        logTrade(market, predictionLog, 'skipped', signalSkipReason || 'signal_skipped', null, null, orderFlow);
        return;
    }

    if (!direction) {
        logTrade(market, predictionLog, 'skipped', 'no_direction', null, null, orderFlow);
        return;
    }

    if (activeMinConfidence > 0 && confidence < activeMinConfidence) {
        logger.info(`DIRECTIONAL: ${direction} too weak (${(confidence * 100).toFixed(0)}% < ${activeMinConfidence * 100}%)`);
        logTrade(market, predictionLog, 'skipped', 'low_confidence', null, null, orderFlow);
        return;
    }

    // Determine actual sizing
    const maxShares = activeSharesMax || 10;
    const minShares = Math.min(5, maxShares);
    let tradeShares = Math.round((minShares + (confidence * (maxShares - minShares))) * 100) / 100;

    const effectivePrice = activeEntryPriceInitial;
    if (effectivePrice > (config.directionalMaxEntryPrice || 0.75)) {
        logTrade(market, predictionLog, 'skipped', 'price_too_high', null, null, orderFlow);
        return;
    }

    const cost = effectivePrice * tradeShares;

    // Daily limit check
    const dailyLimit = config.directionalDailyLossLimit;
    if (dailyLimit > 0 && !config.dryRun) {
        const pnl = getBalancePnl();
        const currentBalance = await getUsdcBalance();
        if (pnl && currentBalance && (pnl.sessionStartBalance - currentBalance) >= dailyLimit) {
            logTrade(market, predictionLog, 'skipped', 'daily_limit', null, null, orderFlow);
            return;
        }
    }

    const book = validateOrderbook(direction === 'UP' ? yesTokenId : noTokenId, await fetchOrderbook(direction === 'UP' ? yesTokenId : noTokenId));
    if (!book || book.bestAsk > effectivePrice + 0.05) {
        logTrade(market, predictionLog, 'skipped', 'orderbook_blocked', null, book, orderFlow);
        return;
    }

    if (!config.dryRun && (await getUsdcBalance()) < cost) {
        logTrade(market, predictionLog, 'skipped', 'no_balance', null, book, orderFlow);
        return;
    }

    // Execution
    const netPayout = computeNetPayout(tradeShares, effectivePrice);
    if (config.dryRun) {
        logger.trade(`DIRECTIONAL[SIM]: BUY ${direction} @ ${effectivePrice} for ${asset}`);
        logTrade(market, predictionLog, 'placed', 'dry_run', 'sim-' + Date.now(), book, orderFlow, { fundingRate, tradeShares, actualPrice: effectivePrice });
        return;
    }

    try {
        const { res } = await submitOrderTimed({
            tokenID: direction === 'UP' ? yesTokenId : noTokenId,
            side: Side.BUY,
            price: effectivePrice,
            size: tradeShares,
        }, { tickSize, negRisk }, OrderType.GTC);

        if (res?.success) {
            logger.money(`DIRECTIONAL: PLACED ${direction} for ${asset} @ ${effectivePrice}`);
            logTrade(market, predictionLog, 'placed', null, res.orderID, book, orderFlow, { fundingRate, tradeShares, actualPrice: effectivePrice });
            addDailySpend(cost);
        } else {
            logTrade(market, predictionLog, 'failed', res?.errorMsg || 'unknown', null, book, orderFlow, { tradeShares, actualPrice: effectivePrice });
        }
    } catch (err) {
        logTrade(market, predictionLog, 'error', err.message, null, book, orderFlow, { tradeShares, actualPrice: effectivePrice });
    }
}

function logTrade(market, prediction, status, reason, orderId, book, flow, meta = {}) {
    const price = meta.actualPrice || config.directionalEntryPrice;
    const shares = meta.tradeShares || config.directionalShares;
    const fee = computeFeeShares(shares, price);
    appendOrder({
        ts: new Date().toISOString(),
        orderTs: Math.floor(Date.now() / 1000),
        conditionId: market.conditionId,
        asset: (market.asset || '').toUpperCase(),
        marketId: `${(market.asset || 'BTC').toUpperCase()}_${market.slotTimestamp}`,
        question: (market.question || '').slice(0, 200),
        signal: prediction.signal,
        signalMinutes: prediction.signalMinutes,
        direction: prediction.direction, 
        status,
        reason: reason || null,
        entered: status === 'placed' ? 1 : 0,
        orderId: orderId || null,
        price, // 🟢 FIXED: logs actual entry price
        shares,
        cost: price * shares,
        confidence: prediction.confidence ?? null,
        fundingRate: meta.fundingRate ?? null,
        obi: flow?.obiAvg ?? null,
        cvd: flow?.cvd ?? null,
        features: prediction.features || {} 
    });
}

export function cancelAllPending() {
    for (const timer of pendingTimers.values()) clearTimeout(timer);
    pendingTimers.clear();
}
