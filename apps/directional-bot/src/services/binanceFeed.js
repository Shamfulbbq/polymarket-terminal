/**
 * binanceFeed.js - MULTI-ASSET VERSION
 * Real-time feed from Binance WebSocket for BTC, ETH, SOL, etc.
 */

import WebSocket from 'ws';
import logger from '../utils/logger.js';
import config from '../config/index.js';

const MAX_CANDLE_BUFFER = 60;
const MAX_FLOW_SECONDS = 600; 
const RECONNECT_DELAY_MS = 5000;

let ws = null;
let running = false;
let connectionStatus = 'disconnected';

// Multi-asset state
const state = {};

function initAssetState(asset) {
    if (state[asset]) return;
    state[asset] = {
        candles: [],
        aggTrades: [],
        obiSnapshots: [],
        cvdTotal: 0,
        lastPrice: null,
        lastCandleTime: null,
        bidVolume: 0,
        askVolume: 0,
        currentObi: 0
    };
}

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

function handleKline(asset, data) {
    const s = state[asset];
    const k = data.k;
    s.lastPrice = parseFloat(k.c);
    if (k.x) {
        const candle = parseKline(k);
        s.candles.push(candle);
        if (s.candles.length > MAX_CANDLE_BUFFER) s.candles.shift();
        s.lastCandleTime = new Date(candle.closeTime).toISOString();
    }
}

function handleAggTrade(asset, data) {
    const s = state[asset];
    const isBuy = !data.m; 
    const size = parseFloat(data.q);
    const price = parseFloat(data.p);
    const ts = data.T || Date.now();

    s.aggTrades.push({ ts, price, size, isBuy });
    s.cvdTotal += isBuy ? size : -size;
    s.lastPrice = price;

    const cutoff = Date.now() - MAX_FLOW_SECONDS * 1000;
    while (s.aggTrades.length > 0 && s.aggTrades[0].ts < cutoff) {
        const old = s.aggTrades.shift();
        s.cvdTotal -= old.isBuy ? old.size : -old.size;
    }
}

function handleDepth(asset, data) {
    const s = state[asset];
    const bids = data.bids || [];
    const asks = data.asks || [];

    s.bidVolume = 0;
    s.askVolume = 0;
    for (const [, qty] of bids) s.bidVolume += parseFloat(qty);
    for (const [, qty] of asks) s.askVolume += parseFloat(qty);

    const total = s.bidVolume + s.askVolume;
    s.currentObi = total > 0 ? (s.bidVolume - s.askVolume) / total : 0;

    const now = Date.now();
    s.obiSnapshots.push({ ts: now, obi: s.currentObi, bidVol: s.bidVolume, askVol: s.askVolume });
    if (s.obiSnapshots.length > 600) s.obiSnapshots.shift();
}

// ── WebSocket ────────────────────────────────────────────────────────────────

function connect() {
    if (!running) return;

    // Build streams for each asset
    const assets = (config.directionalAsset || 'btc').split(',').map(a => a.trim().toLowerCase());
    const streams = [];
    assets.forEach(asset => {
        initAssetState(asset);
        const sym = asset === 'btc' ? 'btcusdt' : `${asset}usdt`;
        streams.push(`${sym}@kline_1m`, `${sym}@aggTrade`, `${sym}@depth20@100ms`);
    });

    const url = `wss://stream.binance.com:9443/stream?streams=${streams.join('/')}`;
    ws = new WebSocket(url);

    ws.on('open', () => {
        connectionStatus = 'connected';
        logger.info(`BINANCE: Multi-asset WebSocket connected (${assets.join(', ')})`);
    });

    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw);
            const stream = msg.stream || '';
            const data = msg.data;
            if (!data) return;

            const asset = stream.split('usdt')[0]; // e.g. "btcusdt@kline" -> "btc"
            if (stream.includes('kline'))    handleKline(asset, data);
            else if (stream.includes('aggTrade')) handleAggTrade(asset, data);
            else if (stream.includes('depth'))    handleDepth(asset, data);
        } catch { /* ignore */ }
    });

    ws.on('close', () => {
        connectionStatus = 'disconnected';
        if (running) {
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
}

export function getCandlesSince(asset, sinceMs) {
    const a = asset?.toLowerCase();
    if (!state[a]) return [];
    return state[a].candles.filter((c) => c.openTime >= sinceMs);
}

export function getCandlesBefore(asset, beforeMs, count = 5) {
    const a = asset?.toLowerCase();
    if (!state[a]) return [];
    const before = state[a].candles.filter((c) => c.openTime < beforeMs);
    return before.slice(-count);
}

export async function getBinanceFundingRate(asset) {
    try {
        const sym = (asset?.toLowerCase() === 'btc' ? 'BTC' : asset?.toUpperCase()) + 'USDT';
        const resp = await fetch(
            `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${sym}&limit=1`,
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

export function getOrderFlowSince(asset, sinceMs) {
    const a = asset?.toLowerCase();
    if (!state[a]) return { cvd:0, buyVol:0, sellVol:0, tradeCount:0, obi:0, obiAvg:0 };
    
    const s = state[a];
    let buyVol = 0, sellVol = 0, count = 0;
    for (const t of s.aggTrades) {
        if (t.ts < sinceMs) continue;
        count++;
        if (t.isBuy) buyVol += t.size;
        else sellVol += t.size;
    }
    const cvd = buyVol - sellVol;

    const relevantObi = s.obiSnapshots.filter(ss => ss.ts >= sinceMs);
    const obiAvg = relevantObi.length > 0
        ? relevantObi.reduce((sum, ss) => sum + ss.obi, 0) / relevantObi.length
        : s.currentObi;

    return {
        cvd,
        buyVol,
        sellVol,
        tradeCount: count,
        obi: s.currentObi,
        obiAvg,
        bidVol: s.bidVolume,
        askVol: s.askVolume,
    };
}

export function getBinanceFeedStatus() {
    const assets = Object.keys(state);
    const status = { connectionStatus, assets: {} };
    assets.forEach(a => {
        status.assets[a] = {
            lastPrice: state[a].lastPrice,
            bufferedCandles: state[a].candles.length,
            cvd: Math.round(state[a].cvdTotal * 100) / 100
        };
    });
    return status;
}
