/**
 * binanceFeed.js
 * Real-time BTCUSDT feed from Binance WebSocket.
 *
 * Three streams combined:
 *   1. kline_1m       — 1-minute candles (for momentum, takerBuyRatio signals)
 *   2. aggTrade       — every individual trade (for CVD — Cumulative Volume Delta)
 *   3. depth20@100ms  — top 20 orderbook levels (for OBI — Order Book Imbalance)
 */

import WebSocket from 'ws';
import logger from '../utils/logger.js';

const SYMBOL = 'btcusdt';
const WS_URL = `wss://stream.binance.com:9443/stream?streams=${SYMBOL}@kline_1m/${SYMBOL}@aggTrade/${SYMBOL}@depth20@100ms`;
const MAX_CANDLE_BUFFER = 30;
const MAX_FLOW_SECONDS = 600; // keep 10 minutes of tick data
const RECONNECT_DELAY_MS = 5000;

let ws = null;
let running = false;
const candles = [];
let lastPrice = null;
let lastCandleTime = null;
let connectionStatus = 'disconnected';

// ── Order flow state ─────────────────────────────────────────────────────────

const aggTrades = [];  // { ts, price, size, isBuy }
let cvdTotal = 0;

// Latest depth snapshot
let currentObi = 0;
let bidVolume = 0;
let askVolume = 0;
const obiSnapshots = []; // { ts, obi, bidVol, askVol }
const MAX_OBI_SNAPSHOTS = 600; // ~60s at 100ms intervals

// ── Parsers ──────────────────────────────────────────────────────────────────

function parseKline(k) {
    return {
        openTime: k.t,
        open: parseFloat(k.o),
        high: parseFloat(k.h),
        low: parseFloat(k.l),
        close: parseFloat(k.c),
        volume: parseFloat(k.v),
        closeTime: k.T,
        quoteVolume: parseFloat(k.q),
        trades: k.n,
        takerBuyBaseVol: parseFloat(k.V),
        takerBuyQuoteVol: parseFloat(k.Q),
    };
}

function handleKline(data) {
    const k = data.k;
    lastPrice = parseFloat(k.c);
    if (k.x) {
        const candle = parseKline(k);
        candles.push(candle);
        if (candles.length > MAX_CANDLE_BUFFER) candles.shift();
        lastCandleTime = new Date(candle.closeTime).toISOString();
    }
}

function handleAggTrade(data) {
    const isBuy = !data.m; // m=true means maker is seller → taker is buyer
    const size = parseFloat(data.q);
    const price = parseFloat(data.p);
    const ts = data.T || Date.now();

    aggTrades.push({ ts, price, size, isBuy });
    cvdTotal += isBuy ? size : -size;
    lastPrice = price;

    // Trim old ticks
    const cutoff = Date.now() - MAX_FLOW_SECONDS * 1000;
    while (aggTrades.length > 0 && aggTrades[0].ts < cutoff) {
        const old = aggTrades.shift();
        cvdTotal -= old.isBuy ? old.size : -old.size;
    }
}

function handleDepth(data) {
    const bids = data.bids || [];
    const asks = data.asks || [];

    bidVolume = 0;
    askVolume = 0;
    for (const [, qty] of bids) bidVolume += parseFloat(qty);
    for (const [, qty] of asks) askVolume += parseFloat(qty);

    const total = bidVolume + askVolume;
    currentObi = total > 0 ? (bidVolume - askVolume) / total : 0;

    const now = Date.now();
    obiSnapshots.push({ ts: now, obi: currentObi, bidVol: bidVolume, askVol: askVolume });
    if (obiSnapshots.length > MAX_OBI_SNAPSHOTS) obiSnapshots.shift();
}

// ── WebSocket ────────────────────────────────────────────────────────────────

function connect() {
    if (!running) return;

    ws = new WebSocket(WS_URL);

    ws.on('open', () => {
        connectionStatus = 'connected';
        logger.info('BINANCE: WebSocket connected (kline + aggTrade + depth)');
    });

    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw);
            const stream = msg.stream || '';
            const data = msg.data;
            if (!data) return;

            if (stream.includes('kline'))    handleKline(data);
            else if (stream.includes('aggTrade')) handleAggTrade(data);
            else if (stream.includes('depth'))    handleDepth(data);
        } catch { /* ignore parse errors */ }
    });

    ws.on('close', () => {
        connectionStatus = 'disconnected';
        if (running) {
            logger.warn(`BINANCE: WebSocket closed — reconnecting in ${RECONNECT_DELAY_MS / 1000}s`);
            setTimeout(connect, RECONNECT_DELAY_MS);
        }
    });

    ws.on('error', (err) => {
        connectionStatus = 'error';
        logger.error(`BINANCE: WebSocket error — ${err.message}`);
    });
}

// ── Public API ───────────────────────────────────────────────────────────────

export function startBinanceFeed() {
    running = true;
    connect();
}

export function stopBinanceFeed() {
    running = false;
    if (ws) {
        try { ws.close(); } catch { /* ignore */ }
        ws = null;
    }
    connectionStatus = 'stopped';
}

export function getCandlesSince(sinceMs) {
    return candles.filter((c) => c.openTime >= sinceMs);
}

/**
 * Get the N most recent candles that closed BEFORE a given timestamp.
 * Used to compute pre-market momentum before a market opens.
 */
export function getCandlesBefore(beforeMs, count = 5) {
    const before = candles.filter((c) => c.openTime < beforeMs);
    return before.slice(-count);
}

/**
 * Fetch the latest BTC perpetual futures funding rate from Binance.
 * Negative funding = shorts paying longs = UP bias (shorts squeezed).
 * Positive funding = longs paying shorts = DOWN bias (longs crowded).
 * Returns null on error.
 */
export async function getBinanceFundingRate() {
    try {
        const resp = await fetch(
            'https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=1',
            { signal: AbortSignal.timeout(3000) },
        );
        if (!resp.ok) return null;
        const data = await resp.json();
        if (!Array.isArray(data) || data.length === 0) return null;
        return parseFloat(data[0].fundingRate);
    } catch {
        return null;
    }
}

/**
 * Get order flow data for a given time window.
 * @param {number} sinceMs — UTC timestamp in milliseconds
 * @returns {{ cvd, buyVol, sellVol, tradeCount, obi, obiAvg, bidVol, askVol }}
 */
export function getOrderFlowSince(sinceMs) {
    let buyVol = 0, sellVol = 0, count = 0;
    for (const t of aggTrades) {
        if (t.ts < sinceMs) continue;
        count++;
        if (t.isBuy) buyVol += t.size;
        else sellVol += t.size;
    }
    const cvd = buyVol - sellVol;

    // Average OBI over the window
    const relevantObi = obiSnapshots.filter(s => s.ts >= sinceMs);
    const obiAvg = relevantObi.length > 0
        ? relevantObi.reduce((sum, s) => sum + s.obi, 0) / relevantObi.length
        : currentObi;

    return {
        cvd,
        buyVol,
        sellVol,
        tradeCount: count,
        obi: currentObi,
        obiAvg,
        bidVol: bidVolume,
        askVol: askVolume,
    };
}

export function getBinanceFeedStatus() {
    return {
        status: connectionStatus,
        lastPrice,
        lastCandleTime,
        bufferedCandles: candles.length,
        aggTradeCount: aggTrades.length,
        cvd: Math.round(cvdTotal * 1000) / 1000,
        obi: Math.round(currentObi * 1000) / 1000,
    };
}
