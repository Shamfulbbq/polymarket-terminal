/**
 * recorder.mjs
 * Live data recorder for BTC UP/DN 5-min market.
 *
 * Captures every 5-min round:
 *   - Binance BTC/USDT 1m klines + 100ms trade flow
 *   - Polymarket UP/DN asks (polled every 500ms)
 *   - TCN inference server predictions (polled every 10s)
 *   - Round resolution (win/loss + Chainlink-derived open/close prices)
 *
 * Output files (append-only JSONL):
 *   data/btc5m/rounds.jsonl   — one row per resolved round
 *   data/btc5m/ticks.jsonl    — 100ms snapshots during active rounds
 *
 * Usage:
 *   node src/btc5m/recorder.mjs
 *   BTC5M_INFER_URL=http://127.0.0.1:5100 node src/btc5m/recorder.mjs
 *
 * Does NOT trade. Pure recorder — safe to run alongside any other bot.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';
import { FlowTracker, BookDeltaTracker, recommendMode } from './signal.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..', '..');
const DATA_DIR  = path.join(ROOT, 'data', 'btc5m');
fs.mkdirSync(DATA_DIR, { recursive: true });

const ROUNDS_LOG = path.join(DATA_DIR, 'rounds.jsonl');
const TICKS_LOG  = path.join(DATA_DIR, 'ticks.jsonl');

const INFER_URL  = process.env.BTC5M_INFER_URL || 'http://127.0.0.1:5100';
const CLOB_HOST  = 'https://clob.polymarket.com';
const GAMMA_HOST = 'https://gamma-api.polymarket.com';
const ROUND_SEC  = 300;
const TICK_MS    = 1000;   // how often to poll PM orderbook (was 500 — reduce rate pressure)
const INFER_MS   = 10_000; // how often to call inference server

// ── Utils ────────────────────────────────────────────────────────────────────

function now() { return Date.now(); }
function log(msg) { console.log(`[btc5m-rec] ${new Date().toISOString().slice(11, 19)} ${msg}`); }
function appendJsonl(file, obj) {
    fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}
function currentRoundTs() {
    return Math.floor(Date.now() / 1000 / ROUND_SEC) * ROUND_SEC;
}

// ── Binance WebSocket ─────────────────────────────────────────────────────────

const _candles = [];   // last 60 closed 1m candles
const PRICE = { value: null, ts: null };
const DEPTH = { bids: [], asks: [], ts: null };
let _ws = null;

// Flow / book delta trackers (rolling 3s/30s windows)
const _flow = new FlowTracker();
const _book = new BookDeltaTracker();

const BN_STREAMS = 'btcusdt@kline_1m/btcusdt@aggTrade/btcusdt@depth5@100ms';
const BN_URL = `wss://stream.binance.com:9443/stream?streams=${BN_STREAMS}`;

function connectBinance() {
    _ws = new WebSocket(BN_URL);

    _ws.on('open', () => log('Binance WebSocket connected'));
    _ws.on('close', () => { log('Binance WS closed — reconnecting in 5s'); setTimeout(connectBinance, 5000); });
    _ws.on('error', err => log(`Binance WS error: ${err.message}`));

    _ws.on('message', raw => {
        try {
            const msg = JSON.parse(raw);
            const stream = msg.stream || '';
            const data = msg.data;
            if (!data) return;

            if (stream.includes('kline')) {
                const k = data.k;
                PRICE.value = parseFloat(k.c);
                PRICE.ts = now();
                if (k.x) { // closed candle
                    _candles.push({
                        openTime: k.t,
                        open:  parseFloat(k.o),
                        high:  parseFloat(k.h),
                        low:   parseFloat(k.l),
                        close: parseFloat(k.c),
                        volume: parseFloat(k.v),
                        takerBuyBaseVol: parseFloat(k.V),
                    });
                    if (_candles.length > 120) _candles.shift();
                }
            } else if (stream.includes('depth')) {
                DEPTH.bids = (data.bids || []).slice(0, 5);
                DEPTH.asks = (data.asks || []).slice(0, 5);
                DEPTH.ts = now();
            } else if (stream.includes('aggTrade')) {
                PRICE.value = parseFloat(data.p);
                PRICE.ts = now();
                // Feed flow tracker: q = base qty (BTC), m = isBuyerMaker
                // m=true  → taker SOLD into bids
                // m=false → taker BOUGHT from asks
                const qty = parseFloat(data.q);
                const isBuyerMaker = data.m === true;
                const tradeTs = data.T || now();
                _flow.addTrade(qty, isBuyerMaker, tradeTs, parseFloat(data.p));
            }
        } catch { /* ignore */ }
    });
}

// ── Feature vector for inference ─────────────────────────────────────────────

// Compute features on full candle buffer; slice last 60.
// Must match build_dataset.py _candle_features and bot.mjs buildFeatureSeq.
function buildFeatureSeq(candles) {
    if (candles.length < 60 + 30) return null;
    const n = candles.length;
    const closes = candles.map(c => c.close);
    const vols   = candles.map(c => c.volume);

    const volMa30 = new Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
        sum += vols[i];
        if (i >= 30) sum -= vols[i - 30];
        const win = Math.min(i + 1, 30);
        volMa30[i] = sum / win;
    }

    const feats = candles.map((c, i) => {
        const ret        = (c.close - c.open) / (c.open + 1e-8);
        const logVol     = Math.log1p(c.volume);
        const takerRatio = c.takerBuyBaseVol / (c.volume + 1e-8);
        const hlRange    = (c.high - c.low) / (c.open + 1e-8);
        const bodyRatio  = Math.abs(c.close - c.open) / (c.high - c.low + 1e-8);
        const ret5       = i >= 5  ? (closes[i] - closes[i-5])  / (closes[i-5]  + 1e-8) : 0;
        const ret15      = i >= 15 ? (closes[i] - closes[i-15]) / (closes[i-15] + 1e-8) : 0;
        const ret30      = i >= 30 ? (closes[i] - closes[i-30]) / (closes[i-30] + 1e-8) : 0;
        const volRatio   = c.volume / (volMa30[i] + 1e-8);
        const tSec    = Math.floor(c.openTime / 1000);
        const hour    = (tSec % 86400) / 3600;
        const dow     = Math.floor(tSec / 86400) % 7;
        const hourSin = Math.sin(hour * 2 * Math.PI / 24);
        const hourCos = Math.cos(hour * 2 * Math.PI / 24);
        const dowSin  = Math.sin(dow  * 2 * Math.PI / 7);
        const dowCos  = Math.cos(dow  * 2 * Math.PI / 7);
        return [ret, logVol, takerRatio, hlRange, bodyRatio,
                ret5, ret15, ret30, volRatio,
                hourSin, hourCos, dowSin, dowCos];
    });
    return feats.slice(-60);
}

// ── Inference server ──────────────────────────────────────────────────────────

async function fetchPrediction(upAsk, dnAsk) {
    const seq = buildFeatureSeq(_candles);
    if (!seq) return null;
    try {
        const resp = await fetch(`${INFER_URL}/predict`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ candles: seq, up_ask: upAsk, dn_ask: dnAsk }),
            signal: AbortSignal.timeout(3000),
        });
        if (!resp.ok) return null;
        return await resp.json();
    } catch { return null; }
}

// ── Polymarket market resolution ──────────────────────────────────────────────

// Cache: roundTs -> { upTokenId, dnTokenId, conditionId, slug }
const _marketCache = new Map();

async function fetchMarketForRound(roundTs) {
    if (_marketCache.has(roundTs)) return _marketCache.get(roundTs);

    const slug = `btc-updown-5m-${roundTs}`;
    try {
        const resp = await fetch(
            `${GAMMA_HOST}/markets?slug=${slug}&limit=1`,
            { signal: AbortSignal.timeout(5000) }
        );
        if (!resp.ok) return null;
        const data = await resp.json();
        const markets = data.markets || data;
        if (!Array.isArray(markets) || markets.length === 0) return null;
        const m = markets[0];
        const tokens = m.clobTokenIds ? JSON.parse(m.clobTokenIds) : [];
        if (tokens.length < 2) return null;

        const entry = {
            slug,
            conditionId: m.conditionId,
            upTokenId: tokens[0],   // YES = UP for btc-updown markets
            dnTokenId: tokens[1],
            question: m.question || '',
        };
        _marketCache.set(roundTs, entry);
        return entry;
    } catch { return null; }
}

async function fetchBook(tokenId) {
    try {
        const resp = await fetch(`${CLOB_HOST}/book?token_id=${tokenId}`, {
            signal: AbortSignal.timeout(3000),
        });
        if (!resp.ok) return null;
        const book = await resp.json();
        const asks = (book.asks || []);
        const bestAsk = asks.length > 0 ? parseFloat(asks[asks.length - 1].price) : null;
        return bestAsk;
    } catch { return null; }
}

// ── Round state machine ───────────────────────────────────────────────────────

let _currentRoundTs = null;
let _roundState = null; // { openTs, openPrice, market, upAsks[], dnAsks[], preds[] }

function onRoundOpen(roundTs) {
    _currentRoundTs = roundTs;
    _roundState = {
        openTs: roundTs,
        openPrice: PRICE.value,
        upAsks: [],
        dnAsks: [],
        preds: [],
        market: null,
    };
    log(`Round open: btc-updown-5m-${roundTs} @ $${PRICE.value?.toFixed(1)}`);

    // fetch market info in background
    fetchMarketForRound(roundTs).then(m => {
        if (m && _roundState) _roundState.market = m;
    });
}

// Poll Polymarket for the actual Chainlink-based resolution.
// Binance price is a biased label (different oracle, time granularity mismatch).
// We retry for up to ~90s after round end because resolution isn't instant.
async function fetchResolvedOutcome(slug, retriesLeft = 30) {
    try {
        const resp = await fetch(`https://gamma-api.polymarket.com/markets?slug=${slug}&closed=true&limit=1`,
            { signal: AbortSignal.timeout(5000) });
        if (!resp.ok) throw new Error(`status ${resp.status}`);
        const data = await resp.json();
        const m = Array.isArray(data) ? data[0] : (data.markets || [])[0];
        if (!m) throw new Error('no market');
        // Resolution fields observed on Gamma: `umaResolutionStatus`, `resolvedBy`, `outcomes`, `outcomePrices`
        // When resolved, `outcomePrices` = ["1","0"] for UP, ["0","1"] for DN
        const prices = m.outcomePrices ? JSON.parse(m.outcomePrices) : null;
        if (!prices || prices.length < 2) throw new Error('no outcomePrices');
        const upP = parseFloat(prices[0]);
        const dnP = parseFloat(prices[1]);
        if (upP === 1 && dnP === 0) return 'UP';
        if (upP === 0 && dnP === 1) return 'DN';
        // still unresolved (both 0.5 or similar)
        throw new Error(`unresolved prices=${prices.join(',')}`);
    } catch (e) {
        if (retriesLeft <= 0) {
            log(`resolve ${slug}: giving up — ${e.message}`);
            return null;
        }
        await new Promise(r => setTimeout(r, 10_000));
        return fetchResolvedOutcome(slug, retriesLeft - 1);
    }
}

function onRoundClose(roundTs) {
    if (!_roundState || _roundState.openTs !== roundTs) return;
    const closePrice = PRICE.value;

    const upAskAvg = _roundState.upAsks.length > 0
        ? _roundState.upAsks.reduce((a, b) => a + b, 0) / _roundState.upAsks.length
        : null;
    const dnAskAvg = _roundState.dnAsks.length > 0
        ? _roundState.dnAsks.reduce((a, b) => a + b, 0) / _roundState.dnAsks.length
        : null;

    const lastPred = _roundState.preds.at(-1) ?? null;
    const slug = `btc-updown-5m-${roundTs}`;
    const openPrice = _roundState.openPrice;
    const tickCount = _roundState.upAsks.length;
    _roundState = null;

    // Kick off resolution fetch in background — Chainlink-backed ground truth.
    // Also log a provisional row with Binance-based label so we have something
    // immediately; the real label comes later (polled below, we log a separate
    // row with `resolved: true` when it arrives).
    const provisionalLabel = closePrice != null && openPrice != null
        ? (closePrice >= openPrice ? 'UP' : 'DN')  // Polymarket rule: >= resolves UP
        : null;

    appendJsonl(ROUNDS_LOG, {
        ts: now(),
        slug,
        open_ts: roundTs,
        close_ts: roundTs + ROUND_SEC,
        open_price_binance: openPrice,
        close_price_binance: closePrice,
        provisional_label: provisionalLabel,
        resolved_label: null,  // filled by async follow-up
        up_ask_avg: upAskAvg ? +upAskAvg.toFixed(4) : null,
        dn_ask_avg: dnAskAvg ? +dnAskAvg.toFixed(4) : null,
        pred_up: lastPred?.pred_up ?? null,
        pred_dn: lastPred?.pred_dn ?? null,
        ev_up: lastPred?.ev_up ?? null,
        ev_dn: lastPred?.ev_dn ?? null,
        tick_count: tickCount,
    });
    log(`Round closed: provisional=${provisionalLabel ?? '?'} (Binance ${openPrice?.toFixed(1)}→${closePrice?.toFixed(1)}) ticks=${tickCount} — awaiting Chainlink resolution`);

    fetchResolvedOutcome(slug).then(resolved => {
        if (resolved === null) return;
        appendJsonl(ROUNDS_LOG, {
            ts: now(),
            slug,
            resolved: true,
            resolved_label: resolved,
            provisional_label: provisionalLabel,
            match: provisionalLabel === resolved,
        });
        const tag = provisionalLabel === resolved ? 'MATCH' : 'DIFF';
        log(`Resolved ${slug}: Chainlink=${resolved} Binance=${provisionalLabel} [${tag}]`);
    });
}

// ── Tick loop (TICK_MS interval) ─────────────────────────────────────────────

let _lastPred = null;
let _lastInferAt = 0;

async function tick() {
    const rts = currentRoundTs();

    if (rts !== _currentRoundTs) {
        if (_currentRoundTs !== null) onRoundClose(_currentRoundTs);
        onRoundOpen(rts);
    }

    if (!_roundState) return;

    const m = _roundState.market;
    let upAsk = null, dnAsk = null;
    if (m) {
        [upAsk, dnAsk] = await Promise.all([
            fetchBook(m.upTokenId),
            fetchBook(m.dnTokenId),
        ]);
        if (upAsk !== null) _roundState.upAsks.push(upAsk);
        if (dnAsk !== null) _roundState.dnAsks.push(dnAsk);
        // Feed book delta tracker — even if one side is null
        _book.addSnap(upAsk, dnAsk, now());
    }

    // Refresh prediction every INFER_MS
    if (now() - _lastInferAt > INFER_MS) {
        const pred = await fetchPrediction(upAsk, dnAsk);
        if (pred) {
            _lastPred = pred;
            _roundState.preds.push(pred);
            log(`pred_up=${pred.pred_up.toFixed(3)} ev_up=${pred.ev_up?.toFixed(3) ?? 'n/a'} ev_dn=${pred.ev_dn?.toFixed(3) ?? 'n/a'}`);
        }
        _lastInferAt = now();
    }

    // Compute rolling signals
    const flowSig = _flow.compute(now());
    const bookSig = _book.compute(now());
    const rec     = recommendMode(flowSig);

    // Write tick
    const timeRem = (rts + ROUND_SEC) - Math.floor(now() / 1000);
    appendJsonl(TICKS_LOG, {
        ts: now(),
        slug: `btc-updown-5m-${rts}`,
        time_rem: timeRem,
        round_open_price: _roundState?.openPrice ?? null,
        btc_price: PRICE.value,
        up_ask: upAsk,
        dn_ask: dnAsk,
        pred_up: _lastPred?.pred_up ?? null,
        ev_up: _lastPred?.ev_up ?? null,
        candles_buffered: _candles.length,
        // Order-flow signals
        flow1s:   flowSig.flow1s,
        flow3s:   flowSig.flow3s,
        flow30s:  flowSig.flow30s,
        bias1s:   flowSig.bias1s,
        bias3s:   flowSig.bias3s,
        bias30s:  flowSig.bias30s,
        trades1s: flowSig.trades1s,
        trades3s: flowSig.trades3s,
        trades30s: flowSig.trades30s,
        vol1s:    flowSig.vol1s,
        vol3s:    flowSig.vol3s,
        vol30s:   flowSig.vol30s,
        buyVol1s:  flowSig.buyVol1s,
        sellVol1s: flowSig.sellVol1s,
        buyVol3s:  flowSig.buyVol3s,
        sellVol3s: flowSig.sellVol3s,
        buyVol30s:  flowSig.buyVol30s,
        sellVol30s: flowSig.sellVol30s,
        vwap1s:   flowSig.vwap1s,
        vwap3s:   flowSig.vwap3s,
        vwap30s:  flowSig.vwap30s,
        // Polymarket book delta
        upAskDelta3s:    bookSig?.upAskDelta3s   ?? null,
        upAskDelta30s:   bookSig?.upAskDelta30s  ?? null,
        dnAskDelta3s:    bookSig?.dnAskDelta3s   ?? null,
        dnAskDelta30s:   bookSig?.dnAskDelta30s  ?? null,
        spreadDelta3s:   bookSig?.spreadDelta3s  ?? null,
        spreadDelta30s:  bookSig?.spreadDelta30s ?? null,
        // Binance L2 order book (top 5 levels)
        bid_px0: DEPTH.bids[0] ? +DEPTH.bids[0][0] : null,
        bid_px1: DEPTH.bids[1] ? +DEPTH.bids[1][0] : null,
        bid_px2: DEPTH.bids[2] ? +DEPTH.bids[2][0] : null,
        bid_px3: DEPTH.bids[3] ? +DEPTH.bids[3][0] : null,
        bid_px4: DEPTH.bids[4] ? +DEPTH.bids[4][0] : null,
        ask_px0: DEPTH.asks[0] ? +DEPTH.asks[0][0] : null,
        ask_px1: DEPTH.asks[1] ? +DEPTH.asks[1][0] : null,
        ask_px2: DEPTH.asks[2] ? +DEPTH.asks[2][0] : null,
        ask_px3: DEPTH.asks[3] ? +DEPTH.asks[3][0] : null,
        ask_px4: DEPTH.asks[4] ? +DEPTH.asks[4][0] : null,
        bid_sz0: DEPTH.bids[0] ? +DEPTH.bids[0][1] : null,
        bid_sz1: DEPTH.bids[1] ? +DEPTH.bids[1][1] : null,
        bid_sz2: DEPTH.bids[2] ? +DEPTH.bids[2][1] : null,
        bid_sz3: DEPTH.bids[3] ? +DEPTH.bids[3][1] : null,
        bid_sz4: DEPTH.bids[4] ? +DEPTH.bids[4][1] : null,
        ask_sz0: DEPTH.asks[0] ? +DEPTH.asks[0][1] : null,
        ask_sz1: DEPTH.asks[1] ? +DEPTH.asks[1][1] : null,
        ask_sz2: DEPTH.asks[2] ? +DEPTH.asks[2][1] : null,
        ask_sz3: DEPTH.asks[3] ? +DEPTH.asks[3][1] : null,
        ask_sz4: DEPTH.asks[4] ? +DEPTH.asks[4][1] : null,
        // Recommended mode (informational — recorder doesn't act on it)
        rec_mode:   rec.mode,
        rec_reason: rec.reason,
    });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    log('Starting BTC5M recorder...');
    log(`Data dir: ${DATA_DIR}`);
    log(`Inference: ${INFER_URL} (optional — predictions skipped if server is down)`);

    connectBinance();

    // Prefill candles from REST before WS is ready
    try {
        const resp = await fetch(
            'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=120',
            { signal: AbortSignal.timeout(10000) }
        );
        if (resp.ok) {
            const rows = await resp.json();
            for (const r of rows) {
                _candles.push({
                    openTime: r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4],
                    volume: +r[5], takerBuyBaseVol: +r[9],
                });
            }
            log(`Pre-filled ${_candles.length} 1m candles from REST`);
        }
    } catch (e) { log(`Pre-fill failed: ${e.message}`); }

    // Kick off round — don't wait for first WS message
    _currentRoundTs = currentRoundTs();
    onRoundOpen(_currentRoundTs);

    setInterval(tick, TICK_MS);
    log('Recording... (Ctrl-C to stop)');
}

main().catch(err => { console.error(err); process.exit(1); });
