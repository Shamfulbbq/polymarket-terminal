import WebSocket from 'ws';
import logger from '../utils/logger.js';

const ASSETS = ['btcusdt', 'ethusdt', 'solusdt'];
const STREAMS = ASSETS.flatMap(s => [`${s}@kline_1m`, `${s}@aggTrade`, `${s}@depth20@100ms`]);
const WS_URL = `wss://stream.binance.com:9443/stream?streams=${STREAMS.join('/')}`;
const MAX_CANDLE_BUFFER = 200; // needs 200 for frac_diff_close (FFD d=0.35)
const MAX_FLOW_SECONDS = 600;
const RECONNECT_DELAY_MS = 5000;

let ws = null;
let running = false;
let connectionStatus = 'disconnected';

// ── Per-asset state ─────────────────────────────────────────────────────────

const _candles    = new Map(); // symbol -> candle[]
const _aggTrades  = new Map(); // symbol -> trade[]
const _cvdTotal   = new Map(); // symbol -> number
const _obi        = new Map(); // symbol -> { current, bidVol, askVol, snapshots[] }
const _priceCache = new Map(); // symbol -> { price, updatedAt }
const _lastCandleTime = new Map(); // symbol -> ISO string

for (const s of ASSETS) {
    _candles.set(s, []);
    _aggTrades.set(s, []);
    _cvdTotal.set(s, 0);
    _obi.set(s, { current: 0, bidVol: 0, askVol: 0, snapshots: [] });
}

const MAX_OBI_SNAPSHOTS = 600;

function _symbol(stream) {
    return stream.split('@')[0];
}

// ── Parsers ─────────────────────────────────────────────────────────────────

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

function handleKline(data, stream) {
    const k = data.k;
    const price = parseFloat(k.c);
    const sym = _symbol(stream);
    _priceCache.set(sym, { price, updatedAt: Date.now() });

    if (k.x) {
        const buf = _candles.get(sym);
        if (buf) {
            buf.push(parseKline(k));
            if (buf.length > MAX_CANDLE_BUFFER) buf.shift();
            _lastCandleTime.set(sym, new Date(k.T).toISOString());
        }
    }
}

function handleAggTrade(data, stream) {
    const sym = _symbol(stream);
    const isBuy = !data.m;
    const size = parseFloat(data.q);
    const price = parseFloat(data.p);
    const ts = data.T || Date.now();

    _priceCache.set(sym, { price, updatedAt: Date.now() });

    const trades = _aggTrades.get(sym);
    if (!trades) return;
    trades.push({ ts, price, size, isBuy });
    _cvdTotal.set(sym, (_cvdTotal.get(sym) || 0) + (isBuy ? size : -size));

    const cutoff = Date.now() - MAX_FLOW_SECONDS * 1000;
    while (trades.length > 0 && trades[0].ts < cutoff) {
        const old = trades.shift();
        _cvdTotal.set(sym, (_cvdTotal.get(sym) || 0) - (old.isBuy ? old.size : -old.size));
    }
}

function handleDepth(data, stream) {
    const sym = _symbol(stream);
    const state = _obi.get(sym);
    if (!state) return;

    const bids = data.bids || [];
    const asks = data.asks || [];
    let bidVol = 0, askVol = 0;
    for (const [, qty] of bids) bidVol += parseFloat(qty);
    for (const [, qty] of asks) askVol += parseFloat(qty);

    const total = bidVol + askVol;
    state.current = total > 0 ? (bidVol - askVol) / total : 0;
    state.bidVol = bidVol;
    state.askVol = askVol;

    state.snapshots.push({ ts: Date.now(), obi: state.current, bidVol, askVol });
    if (state.snapshots.length > MAX_OBI_SNAPSHOTS) state.snapshots.shift();
}

// ── WebSocket ───────────────────────────────────────────────────────────────

function connect() {
    if (!running) return;

    ws = new WebSocket(WS_URL);

    ws.on('open', () => {
        connectionStatus = 'connected';
        logger.info(`BINANCE: WebSocket connected (${ASSETS.map(s => s.replace('usdt', '').toUpperCase()).join('/')} kline/depth/trades)`);
    });

    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw);
            const stream = msg.stream || '';
            const data = msg.data;
            if (!data) return;

            if (stream.includes('kline'))         handleKline(data, stream);
            else if (stream.includes('aggTrade')) handleAggTrade(data, stream);
            else if (stream.includes('depth'))    handleDepth(data, stream);
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

// ── Public API ──────────────────────────────────────────────────────────────

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

function _toSymbol(asset) {
    const a = String(asset || 'btc').toLowerCase();
    return a.endsWith('usdt') ? a : `${a}usdt`;
}

export function getCandlesSince(sinceMs, asset) {
    const buf = _candles.get(_toSymbol(asset)) || [];
    return buf.filter(c => c.openTime >= sinceMs);
}

export function getCandlesBefore(beforeMs, count = 5, asset) {
    const buf = _candles.get(_toSymbol(asset)) || [];
    const before = buf.filter(c => c.openTime < beforeMs);
    return before.slice(-count);
}

export async function getBinanceFundingRate(asset) {
    const sym = (asset || 'btc').toUpperCase() + 'USDT';
    try {
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

export async function getBinanceFundingHistory(asset, limit = 20) {
    const sym = (asset || 'btc').toUpperCase() + 'USDT';
    try {
        const resp = await fetch(
            `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${sym}&limit=${limit}`,
            { signal: AbortSignal.timeout(3000) },
        );
        if (!resp.ok) return null;
        const data = await resp.json();
        if (!Array.isArray(data)) return null;
        return data.map(d => parseFloat(d.fundingRate));
    } catch {
        return null;
    }
}

export async function getBinanceLongShortRatio(asset) {
    const sym = (asset || 'btc').toUpperCase() + 'USDT';
    try {
        const resp = await fetch(
            `https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${sym}&period=1h&limit=1`,
            { signal: AbortSignal.timeout(3000) },
        );
        if (!resp.ok) return null;
        const data = await resp.json();
        if (!Array.isArray(data) || data.length === 0) return null;
        return parseFloat(data[0].longShortRatio);
    } catch {
        return null;
    }
}

export function getAllCandles(asset) {
    return _candles.get(_toSymbol(asset)) || [];
}

export function getOrderFlowSince(sinceMs, asset) {
    const sym = _toSymbol(asset);
    const trades = _aggTrades.get(sym) || [];
    const state = _obi.get(sym) || { current: 0, bidVol: 0, askVol: 0, snapshots: [] };

    let buyVol = 0, sellVol = 0, count = 0;
    for (const t of trades) {
        if (t.ts < sinceMs) continue;
        count++;
        if (t.isBuy) buyVol += t.size;
        else sellVol += t.size;
    }

    const relevantObi = state.snapshots.filter(s => s.ts >= sinceMs);
    const obiAvg = relevantObi.length > 0
        ? relevantObi.reduce((sum, s) => sum + s.obi, 0) / relevantObi.length
        : state.current;

    return {
        cvd: buyVol - sellVol,
        buyVol,
        sellVol,
        tradeCount: count,
        obi: state.current,
        obiAvg,
        bidVol: state.bidVol,
        askVol: state.askVol,
    };
}

export function getLastPrice(symbol) {
    const ticker = `${symbol.toLowerCase()}usdt`;
    return _priceCache.get(ticker) || null;
}

export function getBinanceFeedStatus() {
    const btc = _priceCache.get('btcusdt');
    return {
        status: connectionStatus,
        lastPrice: btc?.price ?? null,
        lastCandleTime: _lastCandleTime.get('btcusdt') ?? null,
        bufferedCandles: (_candles.get('btcusdt') || []).length,
        aggTradeCount: (_aggTrades.get('btcusdt') || []).length,
        cvd: Math.round((_cvdTotal.get('btcusdt') || 0) * 1000) / 1000,
        obi: Math.round((_obi.get('btcusdt')?.current || 0) * 1000) / 1000,
    };
}

// ── Per-asset staleness detection ───────────────────────────────────────────

const STALENESS_THRESHOLD_MS = 120_000; // 2 minutes without data = stale

/**
 * Check feed staleness for a specific asset.
 * Returns { stale, lastUpdateMs, staleDurationMs } or { stale: false }.
 */
export function checkFeedStaleness(asset) {
    const ticker = `${asset.toLowerCase()}usdt`;
    const cached = _priceCache.get(ticker);
    if (!cached || !cached.updatedAt) {
        return { stale: true, lastUpdateMs: null, staleDurationMs: null, reason: 'no_data' };
    }
    const ageMs = Date.now() - cached.updatedAt;
    if (ageMs > STALENESS_THRESHOLD_MS) {
        return { stale: true, lastUpdateMs: cached.updatedAt, staleDurationMs: ageMs, reason: 'timeout' };
    }
    return { stale: false, lastUpdateMs: cached.updatedAt, staleDurationMs: ageMs };
}

/**
 * Check all tracked assets for staleness.
 * Returns Map<asset, stalenessResult>.
 */
export function checkAllFeedStaleness() {
    const results = new Map();
    for (const sym of ASSETS) {
        const asset = sym.replace('usdt', '');
        results.set(asset, checkFeedStaleness(asset));
    }
    return results;
}
