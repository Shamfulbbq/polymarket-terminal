/**
 * bot.mjs
 * Execution bot for Polymarket BTC UP/DN 5-min markets.
 *
 * Strategy — Grid Accumulator (reverse-engineered from target bot):
 *   Every round, place passive resting limit BUYS across the full price grid
 *   (GRID_MIN to GRID_MAX) on BOTH UP and DN simultaneously.
 *
 *   Flat UNIT_SHARES per rung, both sides — matches target bot exactly. The
 *   profit comes from SPREAD CAPTURE: when avg_up + avg_dn < 1.00, each paired
 *   share is guaranteed profit regardless of outcome. The model is informational.
 *   Position asymmetry comes from market dynamics (which fills get hit), not sizing.
 *
 *   Binary market auto-resolves — no exit logic needed.
 *
 * Config via environment variables (see CONFIG block below).
 *
 * Runs safely in DRY_RUN mode by default (set BTC5M_DRY_RUN=false to trade).
 *
 * Usage:
 *   node src/btc5m/bot.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';
import * as ort from 'onnxruntime-web';
import { Side, OrderType } from '@polymarket/clob-client-v2';
import config from '../config/index.js';
import { initClient, getClient, submitOrderTimed } from '../services/clientV2.js';
import logger from '../utils/logger.js';
import { FlowTracker, BookDeltaTracker, recommendMode } from './signal.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..', '..');
const MODEL_DIR = path.join(ROOT, 'models');
const DATA_DIR  = path.join(ROOT, 'data', 'btc5m');
fs.mkdirSync(DATA_DIR, { recursive: true });

const TRADES_LOG = path.join(DATA_DIR, 'bot_trades.jsonl');

// ══════════════════════════════════════════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════════════════════════════════════════

const DRY_RUN           = process.env.BTC5M_DRY_RUN !== 'false';        // default true
const UNIT_SHARES       = parseFloat(process.env.BTC5M_UNIT_SHARES       || '5');    // base shares per rung at 50% confidence
const MAX_RUNGS         = parseInt(  process.env.BTC5M_MAX_RUNGS         || '90', 10);// max rungs per side (90 covers full 0.05-0.95 at 0.01 step)
const GRID_MIN          = parseFloat(process.env.BTC5M_GRID_MIN          || '0.04'); // lowest rung price (matches target bot 0.04)
const GRID_MAX          = parseFloat(process.env.BTC5M_GRID_MAX          || '0.99'); // highest rung price (matches target bot 0.99)
const GRID_STEP         = parseFloat(process.env.BTC5M_GRID_STEP         || '0.01'); // rung spacing — 0.01 matches target bot density
const DAILY_LOSS_LIMIT  = parseFloat(process.env.BTC5M_DAILY_LOSS_LIMIT  || '30');   // USDC, 0 = disabled
const ENTRY_WINDOW_SEC  = parseInt(  process.env.BTC5M_ENTRY_WINDOW_SEC  || '90', 10); // only enter within first N sec of round
// Mid-round hedge: poll book every POLL_SEC seconds. When a bid price >= current ask,
// that rung is simulated as filled. When avg_up + avg_dn < HEDGE_THRESHOLD, spread is
// locked and remaining bids are cancelled (live) or ignored (DRY_RUN).
const POLL_SEC          = parseInt(  process.env.BTC5M_POLL_SEC          || '15', 10); // book poll interval during round
const HEDGE_THRESHOLD   = parseFloat(process.env.BTC5M_HEDGE_THRESHOLD   || '0.92'); // lock spread when avg_up+avg_dn < this

// Polymarket charges 2% on winning payouts (applied at redemption).
// Break-even requires avg_up + avg_dn < 0.98 (not 1.00).
const POLYMARKET_FEE    = 0.02;
const FEE_BREAKEVEN     = 1 - POLYMARKET_FEE; // 0.98

// Order-flow signal: observation-only. recommendMode() returns BALANCED / LEAN_*
// / STRONG_* — never SKIP. The signal gets logged with each round and feeds the
// chase simulator in pollAndHedge. Env vars kept as no-ops for forward compat.
const SIGNAL_ENABLED    = process.env.BTC5M_SIGNAL_ENABLED === 'true';
const SIGNAL_SHADOW     = process.env.BTC5M_SIGNAL_SHADOW  === 'true';
const SIGNAL_MIN_TRADES = parseInt(process.env.BTC5M_SIGNAL_MIN_TRADES || '20', 10);

const ROUND_SEC  = 300;
const SEQ_LEN    = 60;
const NUM_FEATURES = 13;
const GAMMA_HOST = config.gammaHost;
const CLOB_HOST  = config.clobHost;

// ══════════════════════════════════════════════════════════════════════════════
// MODEL LOADING
// ══════════════════════════════════════════════════════════════════════════════

let _session = null;
let _normMean = null;
let _normStd  = null;

async function loadModel() {
    const onnxPath = path.join(MODEL_DIR, 'btc5m_tcn.onnx');
    if (!fs.existsSync(onnxPath)) {
        logger.error(`btc5m: model not found at ${onnxPath} — run train_tcn.py first`);
        process.exit(1);
    }
    _session = await ort.InferenceSession.create(onnxPath);

    const meanPath = path.join(DATA_DIR, 'norm_mean.npy');
    const stdPath  = path.join(DATA_DIR, 'norm_std.npy');
    if (fs.existsSync(meanPath) && fs.existsSync(stdPath)) {
        _normMean = readNpyFloat(meanPath);
        _normStd  = readNpyFloat(stdPath);
        logger.info(`btc5m: model loaded, norm params length=${_normMean.length}`);
    } else {
        logger.warn(`btc5m: norm params missing — predictions may be off`);
    }
}

// Minimal .npy reader — assumes float64 1-D array (numpy default for mean/std)
function readNpyFloat(p) {
    const buf = fs.readFileSync(p);
    const headerLen = buf.readUInt16LE(8);
    const dataOffset = 10 + headerLen;
    const header = buf.slice(10, 10 + headerLen).toString('ascii');
    const is32 = /<f4/.test(header) || /float32/.test(header);
    const arr = [];
    for (let i = dataOffset; i < buf.length; i += (is32 ? 4 : 8)) {
        arr.push(is32 ? buf.readFloatLE(i) : buf.readDoubleLE(i));
    }
    return arr;
}

async function predict(seq) {
    if (!_session) return null;
    // Apply normalisation if available
    let flat = [];
    for (let t = 0; t < SEQ_LEN; t++) {
        for (let f = 0; f < NUM_FEATURES; f++) {
            const raw = seq[t][f];
            const v = _normMean ? (raw - _normMean[f]) / (_normStd[f] || 1) : raw;
            flat.push(v);
        }
    }
    const input = new ort.Tensor('float32', Float32Array.from(flat), [1, SEQ_LEN, NUM_FEATURES]);
    const output = await _session.run({ candles: input });
    const logit = output.logit.data[0];
    const predUp = 1 / (1 + Math.exp(-logit));
    return { pred_up: predUp, pred_dn: 1 - predUp };
}

// ══════════════════════════════════════════════════════════════════════════════
// BINANCE FEED (lightweight — only what the bot needs)
// ══════════════════════════════════════════════════════════════════════════════

const _candles = [];
const PRICE = { value: null, ts: null };

// Order-flow signal trackers (rolling 3s/30s windows)
const _flow = new FlowTracker();
const _book = new BookDeltaTracker();

function connectBinance() {
    const url = 'wss://stream.binance.com:9443/stream?streams=btcusdt@kline_1m/btcusdt@aggTrade';
    const ws  = new WebSocket(url);

    ws.on('open',  () => logger.info('btc5m: Binance WS connected'));
    ws.on('close', () => { logger.warn('btc5m: Binance WS closed, reconnecting in 5s'); setTimeout(connectBinance, 5000); });
    ws.on('error', err => logger.warn(`btc5m: Binance WS error: ${err.message}`));

    ws.on('message', raw => {
        try {
            const msg = JSON.parse(raw);
            const stream = msg.stream || '';
            const d = msg.data;
            if (!d) return;
            if (stream.includes('kline')) {
                const k = d.k;
                PRICE.value = parseFloat(k.c);
                PRICE.ts = Date.now();
                if (k.x) {
                    _candles.push({
                        openTime: k.t, open: +k.o, high: +k.h, low: +k.l, close: +k.c,
                        volume: +k.v, takerBuyBaseVol: +k.V,
                    });
                    if (_candles.length > 120) _candles.shift();
                }
            } else if (stream.includes('aggTrade')) {
                PRICE.value = parseFloat(d.p);
                PRICE.ts = Date.now();
                // Feed flow tracker (m=true => taker SOLD, m=false => taker BOUGHT)
                _flow.addTrade(parseFloat(d.q), d.m === true, d.T || Date.now());
            }
        } catch { /* ignore */ }
    });
}

async function prefillCandles() {
    try {
        const resp = await fetch(
            'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=120',
            { signal: AbortSignal.timeout(10000) });
        if (resp.ok) {
            const rows = await resp.json();
            for (const r of rows) {
                _candles.push({
                    openTime: r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4],
                    volume: +r[5], takerBuyBaseVol: +r[9],
                });
            }
            logger.info(`btc5m: pre-filled ${_candles.length} 1m candles`);
        }
    } catch (e) { logger.warn(`btc5m: pre-fill failed: ${e.message}`); }
}

// ══════════════════════════════════════════════════════════════════════════════
// FEATURE BUILDER — must match build_dataset.py exactly
// ══════════════════════════════════════════════════════════════════════════════

// Compute features on the FULL candle buffer (not just last 60) so that
// rolling returns / vol_ratio at any index i use proper 30-candle history.
// Then slice the last SEQ_LEN feature rows. This matches build_dataset.py
// which computes features over the full DataFrame and indexes per-round.
function buildFeatureSeq() {
    if (_candles.length < SEQ_LEN + 30) return null;  // need extra history for rolling windows
    const n = _candles.length;
    const closes = _candles.map(c => c.close);
    const vols   = _candles.map(c => c.volume);

    // Trailing 30-candle moving avg via running sum (matches Python cumsum version)
    const volMa30 = new Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
        sum += vols[i];
        if (i >= 30) sum -= vols[i - 30];
        const win = Math.min(i + 1, 30);
        volMa30[i] = sum / win;
    }

    const feats = _candles.map((c, i) => {
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
    return feats.slice(-SEQ_LEN);
}

// ══════════════════════════════════════════════════════════════════════════════
// POLYMARKET MARKET FETCHING
// ══════════════════════════════════════════════════════════════════════════════

async function fetchMarketBySlug(slug) {
    try {
        const resp = await fetch(`${GAMMA_HOST}/markets?slug=${slug}&limit=1`,
            { signal: AbortSignal.timeout(5000) });
        if (!resp.ok) return null;
        const data = await resp.json();
        const markets = data.markets || data;
        if (!Array.isArray(markets) || markets.length === 0) return null;
        const m = markets[0];
        const tokens = m.clobTokenIds ? JSON.parse(m.clobTokenIds) : [];
        if (tokens.length < 2) return null;
        return {
            slug,
            conditionId: m.conditionId,
            upTokenId: tokens[0],
            dnTokenId: tokens[1],
            question: m.question || '',
            negRisk: !!m.negRisk,
            tickSize: m.orderPriceMinTickSize ? parseFloat(m.orderPriceMinTickSize) : 0.01,
        };
    } catch { return null; }
}

async function fetchBook(tokenId) {
    try {
        const resp = await fetch(`${CLOB_HOST}/book?token_id=${tokenId}`,
            { signal: AbortSignal.timeout(3000) });
        if (!resp.ok) return null;
        const book = await resp.json();
        const asks = (book.asks || []);
        const bestAsk = asks.length > 0 ? parseFloat(asks[asks.length - 1].price) : null;
        return bestAsk;
    } catch { return null; }
}

// ══════════════════════════════════════════════════════════════════════════════
// EXECUTION — LADDER PLACEMENT
// ══════════════════════════════════════════════════════════════════════════════

// Build passive grid rungs below current best ask on one side.
// Flat UNIT_SHARES per rung on both sides — matches target bot exactly.
// Position asymmetry arises from market dynamics (which fills get hit),
// not from per-rung sizing. The model is informational only.
function computeGridRungs(side, bestAsk, tickSize) {
    const rungs = [];
    let level = GRID_MAX;
    while (rungs.length < MAX_RUNGS && level >= GRID_MIN - 1e-9) {
        const px = Math.round(level / tickSize) * tickSize;
        if (px < bestAsk - 1e-9) {
            rungs.push({ price: +px.toFixed(3), shares: UNIT_SHARES, side });
        }
        level = Math.round((level - GRID_STEP) * 1000) / 1000;
    }
    return rungs;
}

async function placeRung(market, tokenId, rung) {
    const payload = {
        tokenID: tokenId,
        side: Side.BUY,
        price: rung.price,
        size: rung.shares,
    };
    if (DRY_RUN) {
        logger.info(`btc5m [DRY] place ${rung.side} ${rung.shares}@${rung.price}`);
        appendJsonl(TRADES_LOG, { ts: Date.now(), dry: true, slug: market.slug, side: rung.side, ...rung });
        return 'DRY_RUN';
    }
    try {
        const { res } = await submitOrderTimed(
            payload,
            { tickSize: market.tickSize, negRisk: market.negRisk },
            OrderType.GTC,
        );
        if (res?.success) {
            const orderId = res.orderID;
            logger.info(`btc5m: placed ${rung.side} ${rung.shares}@${rung.price} — ${orderId?.slice(0, 10)}`);
            appendJsonl(TRADES_LOG, { ts: Date.now(), event: 'order_placed', slug: market.slug, side: rung.side, orderId, price: rung.price, shares: rung.shares });
            // Track order ID for live hedge cancellation
            if (rung.side === 'UP') _active.upOrderIds.push(orderId);
            else _active.dnOrderIds.push(orderId);
            return orderId;
        }
        logger.warn(`btc5m: rejected ${rung.side} — ${res?.errorMsg || 'unknown'}`);
        return null;
    } catch (err) {
        logger.warn(`btc5m: place error — ${err.message}`);
        return null;
    }
}

function appendJsonl(file, obj) {
    try { fs.appendFileSync(file, JSON.stringify(obj) + '\n'); }
    catch (e) { logger.warn(`btc5m: log append failed — ${e.message}`); }
}

// ══════════════════════════════════════════════════════════════════════════════
// MID-ROUND HEDGE MONITOR
// ══════════════════════════════════════════════════════════════════════════════

// Tracks the active round's bids and simulated fills in real-time.
// A bid fills when the current market ask falls to or below the bid price
// (someone sells into our passive resting limit order).
const _active = {
    slug: null, market: null,
    upBids: [], dnBids: [],
    upFilled: [], dnFilled: [],   // simulated fills accumulated this round
    upOrderIds: [], dnOrderIds: [], // live order IDs for cancellation
    hedged: false, timer: null,
    initialPred: null,            // prediction at round open
    lastMidInferTs: 0,            // timestamp of last mid-round inference
};

function _clearActive() {
    if (_active.timer) { clearInterval(_active.timer); _active.timer = null; }
    Object.assign(_active, { slug: null, market: null, upBids: [], dnBids: [],
        upFilled: [], dnFilled: [], upOrderIds: [], dnOrderIds: [], hedged: false,
        signalMode: null, lastChaseSimTs: 0, initialPred: null, lastMidInferTs: 0 });
}

async function pollAndHedge() {
    if (!_active.slug || _active.hedged) return;

    let upAsk, dnAsk;
    try {
        [upAsk, dnAsk] = await Promise.all([
            fetchBook(_active.market.upTokenId),
            fetchBook(_active.market.dnTokenId),
        ]);
    } catch { return; }
    if (upAsk === null || dnAsk === null) return;

    // Feed Polymarket book delta tracker
    _book.addSnap(upAsk, dnAsk, Date.now());

    // Simulate fills: a passive bid fills when current ask <= bid price
    for (const r of _active.upBids) {
        if (!_active.upFilled.find(f => f.price === r.price) && upAsk <= r.price)
            _active.upFilled.push(r);
    }
    for (const r of _active.dnBids) {
        if (!_active.dnFilled.find(f => f.price === r.price) && dnAsk <= r.price)
            _active.dnFilled.push(r);
    }

    const upSh = _active.upFilled.reduce((a, r) => a + r.shares, 0);
    const dnSh = _active.dnFilled.reduce((a, r) => a + r.shares, 0);
    const upCost = _active.upFilled.reduce((a, r) => a + r.shares * r.price, 0);
    const dnCost = _active.dnFilled.reduce((a, r) => a + r.shares * r.price, 0);
    const avgUp = upSh > 0 ? upCost / upSh : 0;
    const avgDn = dnSh > 0 ? dnCost / dnSh : 0;
    const combined = avgUp + avgDn;

    logger.info(`btc5m: ${_active.slug} poll up_ask=${upAsk} dn_ask=${dnAsk} fills=${upSh}UP/${dnSh}DN avg=${avgUp.toFixed(3)}+${avgDn.toFixed(3)}=${combined.toFixed(3)}`);

    // Chase simulator: when fills are unbalanced, the lagging side's ask is running away.
    // We log what an aggressive chaser would do (cancel stale rungs, lift the runaway ask)
    // so we can measure the counterfactual P&L before placing real orders.
    // Always observation only; never sends orders. Reads _active.signalMode for context.
    {
        const slugStartSec = parseInt(_active.slug.split('-').pop(), 10);
        const timeRem      = slugStartSec ? Math.floor((slugStartSec * 1000 + 300_000 - Date.now()) / 1000) : null;
        const imbalance    = upSh - dnSh; // +ve = too much UP, need DN; -ve = need UP
        const totalSh      = upSh + dnSh;
        if (totalSh > 0 && Math.abs(imbalance) >= UNIT_SHARES) {
            const lagSide  = imbalance > 0 ? 'DN' : 'UP';
            const lagAsk   = lagSide === 'DN' ? dnAsk : upAsk;
            const lagBids  = lagSide === 'DN' ? _active.dnBids : _active.upBids;
            const lagFills = lagSide === 'DN' ? _active.dnFilled : _active.upFilled;
            const filledAvg = lagSide === 'DN' ? avgUp : avgDn;
            const sharesNeeded = Math.abs(imbalance);
            const stale = lagBids.filter(b => !lagFills.find(f => f.price === b.price) && b.price < lagAsk - 0.01);
            const newCombined = filledAvg + lagAsk;
            const viable = newCombined < FEE_BREAKEVEN;
            logger.info(`btc5m: ${_active.slug} CHASE_SIM imbalance=${imbalance}sh lag=${lagSide} lagAsk=${lagAsk} stale=${stale.length} chase=${sharesNeeded}sh@${lagAsk} combined_after=${newCombined.toFixed(3)} viable=${viable} time_rem=${timeRem}s sig=${_active.signalMode}`);
            appendJsonl(TRADES_LOG, { ts: Date.now(), event: 'chase_sim', slug: _active.slug,
                up_sh: upSh, dn_sh: dnSh, imbalance,
                lag_side: lagSide, lag_ask: lagAsk, stale_count: stale.length,
                chase_shares: sharesNeeded, chase_price: lagAsk,
                filled_avg: +filledAvg.toFixed(4), combined_after: +newCombined.toFixed(4),
                fee_breakeven: FEE_BREAKEVEN, viable, time_rem: timeRem,
                signal_mode: _active.signalMode });
        }
    }


    // ── Mid-round re-evaluation ──────────────────────────────────────────────
    // Re-runs inference every 60s. If updated confidence >=55% favours the
    // lagging fill side AND the ask is still cheap (<0.60) AND time_rem >90s,
    // places one extra rung on that side. Logs early-cut signal when model
    // strongly opposes lagging side with <90s remaining.
    {
        const nowMs = Date.now();
        if (nowMs - _active.lastMidInferTs >= 60_000) {
            _active.lastMidInferTs = nowMs;
            const seq = buildFeatureSeq();
            const midPred = await predict(seq);
            if (midPred && _active.initialPred) {
                const slugStartSec = parseInt(_active.slug.split('-').pop(), 10);
                const timeRemMid = Math.max(0, (slugStartSec + 300) - Math.floor(Date.now() / 1000));
                const upSh2 = _active.upFilled.reduce((a, r) => a + r.shares, 0);
                const dnSh2 = _active.dnFilled.reduce((a, r) => a + r.shares, 0);
                const imbalance = upSh2 - dnSh2;
                const lagSide = imbalance > 0 ? 'DN' : imbalance < 0 ? 'UP' : null;

                logger.info(`btc5m: ${_active.slug} MID_INFER pred_up=${midPred.pred_up.toFixed(3)} pred_dn=${midPred.pred_dn.toFixed(3)} initial_up=${_active.initialPred.pred_up.toFixed(3)} lag=${lagSide ?? 'BALANCED'} imbalance=${imbalance}sh time_rem=${timeRemMid}s`);

                if (lagSide && timeRemMid > 90) {
                    const lagPred  = lagSide === 'UP' ? midPred.pred_up : midPred.pred_dn;
                    const lagAskNow = lagSide === 'UP' ? upAsk : dnAsk;

                    if (lagPred >= 0.55 && lagAskNow !== null && lagAskNow < 0.60) {
                        // Model favours lagging side and it's still cheap — add one rung
                        const rungPx = +(lagAskNow - 0.01).toFixed(3);
                        if (rungPx >= GRID_MIN) {
                            const extraRung = { price: rungPx, shares: UNIT_SHARES, side: lagSide };
                            logger.info(`btc5m: ${_active.slug} MID_ADD lag=${lagSide} conf=${lagPred.toFixed(3)} ask=${lagAskNow} → extra rung @${rungPx}`);
                            const tokenId = lagSide === 'UP' ? _active.market.upTokenId : _active.market.dnTokenId;
                            await placeRung(_active.market, tokenId, extraRung);
                            if (lagSide === 'UP') _active.upBids.push(extraRung);
                            else _active.dnBids.push(extraRung);
                        }
                    } else if ((1 - lagPred) >= 0.65) {
                        // Model strongly against lagging side — flag early cut opportunity
                        const losingSh = lagSide === 'UP' ? dnSh2 : upSh2;
                        logger.warn(`btc5m: ${_active.slug} MID_CUT_SIGNAL lag=${lagSide} conf_vs=${(1-lagPred).toFixed(3)} time_rem=${timeRemMid}s losing_side=${losingSh}sh`);
                    }
                }
            }
        }
    }

    // Hedge trigger: spread locked when combined cost < HEDGE_THRESHOLD.
    // With 2% fee, break-even is avg_up+avg_dn < 0.98. HEDGE_THRESHOLD=0.92 is inside that.
    if (upSh > 0 && dnSh > 0 && combined < HEDGE_THRESHOLD) {
        _active.hedged = true;
        clearInterval(_active.timer);
        _active.timer = null;
        const paired = Math.min(upSh, dnSh);
        // Fee-adjusted: winning side pays out at (1 - POLYMARKET_FEE), not 1.00
        const spreadLocked = paired * (FEE_BREAKEVEN - combined);
        const slug = _active.slug;
        logger.info(`btc5m: ${slug} *** HEDGE TRIGGERED *** avg=${avgUp.toFixed(3)}+${avgDn.toFixed(3)}=${combined.toFixed(3)} break_even=${FEE_BREAKEVEN} spread_locked=$${spreadLocked.toFixed(2)} paired=${paired}sh`);
        appendJsonl(TRADES_LOG, { ts: Date.now(), event: 'hedge', slug,
            up_ask: upAsk, dn_ask: dnAsk,
            avg_up: +avgUp.toFixed(4), avg_dn: +avgDn.toFixed(4),
            fee: POLYMARKET_FEE, fee_breakeven: FEE_BREAKEVEN,
            paired, spread_locked: +spreadLocked.toFixed(2) });
        if (!DRY_RUN) {
            // Cancel all remaining open orders to stop accumulating more exposure
            const allOrderIds = [..._active.upOrderIds, ..._active.dnOrderIds].filter(Boolean);
            if (allOrderIds.length > 0) {
                try {
                    const client = getClient();
                    await client.cancelOrders(allOrderIds);
                    logger.info(`btc5m: ${slug} cancelled ${allOrderIds.length} open orders after hedge`);
                    appendJsonl(TRADES_LOG, { ts: Date.now(), event: 'hedge_cancel', slug,
                        cancelled: allOrderIds.length, order_ids: allOrderIds });
                } catch (err) {
                    logger.warn(`btc5m: ${slug} hedge cancel failed — ${err.message}`);
                }
            }
        }
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// ROUND LOOP
// ══════════════════════════════════════════════════════════════════════════════

let _lastRoundTs = null;
let _dailyPnl = 0;
let _dailyDate = new Date().toISOString().slice(0, 10);
// Track open rounds so we can resolve PnL once Chainlink result arrives.
// Key: slug -> { upRungs, dnRungs, upOpenAsk, dnOpenAsk, resolveAttempts }
const _pendingResolution = new Map();

function resetDailyIfNewUtcDay() {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== _dailyDate) {
        _dailyDate = today;
        _dailyPnl = 0;
        logger.info(`btc5m: new UTC day — daily PnL reset`);
    }
}

// Fallback fill simulation used only when mid-round tracking produced no data.
// Winning side: price rose, only rungs near opening ask fill.
// Losing side: price crashed through all bids.
function simulateFillsFallback(rungs, openAsk, thisSideWon) {
    return thisSideWon
        ? rungs.filter(r => r.price >= openAsk - 0.05)
        : rungs;
}

async function resolveAndAccountPnl(slug) {
    const rec = _pendingResolution.get(slug);
    if (!rec) return;
    try {
        const resp = await fetch(`${GAMMA_HOST}/markets?slug=${slug}&closed=true&limit=1`,
            { signal: AbortSignal.timeout(5000) });
        if (!resp.ok) throw new Error(`status ${resp.status}`);
        const data = await resp.json();
        const m = Array.isArray(data) ? data[0] : (data.markets || [])[0];
        const prices = m?.outcomePrices ? JSON.parse(m.outcomePrices) : null;
        if (!prices) throw new Error('no outcomePrices');
        const upWon = parseFloat(prices[0]) === 1;
        const dnWon = parseFloat(prices[1]) === 1;
        if (!upWon && !dnWon) throw new Error('still unresolved');

        // Prefer fills tracked mid-round by pollAndHedge (accurate).
        // Fall back to FILL_WINDOW heuristic if monitor produced nothing.
        const filledUp = rec.trackedUpFills?.length
            ? rec.trackedUpFills
            : simulateFillsFallback(rec.upRungs, rec.upOpenAsk, upWon);
        const filledDn = rec.trackedDnFills?.length
            ? rec.trackedDnFills
            : simulateFillsFallback(rec.dnRungs, rec.dnOpenAsk, dnWon);

        const upShares = filledUp.reduce((a, r) => a + r.shares, 0);
        const dnShares = filledDn.reduce((a, r) => a + r.shares, 0);
        const upCost   = filledUp.reduce((a, r) => a + r.shares * r.price, 0);
        const dnCost   = filledDn.reduce((a, r) => a + r.shares * r.price, 0);

        // Spread capture: paired shares profit when avg_up + avg_dn < FEE_BREAKEVEN (0.98).
        // Polymarket takes 2% of the winning payout, so net per winning share = 0.98.
        const pairedShares = Math.min(upShares, dnShares);
        const avgUp = upShares > 0 ? upCost / upShares : 0;
        const avgDn = dnShares > 0 ? dnCost / dnShares : 0;
        const spreadPerPair = Math.max(0, FEE_BREAKEVEN - avgUp - avgDn);
        const spreadCapture = pairedShares * spreadPerPair;

        // Gross payout minus 2% Polymarket fee on the winning side
        const winningShares = upWon ? upShares : dnShares;
        const grossPayout   = winningShares;
        const fee           = grossPayout * POLYMARKET_FEE;
        const netPayout     = grossPayout - fee;
        const cost          = upCost + dnCost;
        const pnl           = netPayout - cost;
        _dailyPnl += pnl;
        _pendingResolution.delete(slug);
        appendJsonl(TRADES_LOG, { ts: Date.now(), event: 'resolve', slug,
            winner: upWon ? 'UP' : 'DN',
            filled_up: filledUp.length, filled_dn: filledDn.length,
            avg_up: +avgUp.toFixed(4), avg_dn: +avgDn.toFixed(4),
            fee_breakeven: FEE_BREAKEVEN,
            paired: pairedShares, spread_per_pair: +spreadPerPair.toFixed(4),
            spread_capture: +spreadCapture.toFixed(2),
            gross_payout: +grossPayout.toFixed(2), fee: +fee.toFixed(2),
            net_payout: +netPayout.toFixed(2), cost: +cost.toFixed(2),
            pnl: +pnl.toFixed(4), daily_pnl: +_dailyPnl.toFixed(4) });
        logger.info(`btc5m: ${slug} resolved ${upWon ? 'UP' : 'DN'} fills=${filledUp.length}UP/${filledDn.length}DN avg=${avgUp.toFixed(3)}+${avgDn.toFixed(3)}=${(avgUp+avgDn).toFixed(3)} fee_be=${FEE_BREAKEVEN} spread=$${spreadCapture.toFixed(2)} fee=$${fee.toFixed(2)} pnl=${pnl.toFixed(2)} daily=${_dailyPnl.toFixed(2)}`);
    } catch (e) {
        rec.resolveAttempts = (rec.resolveAttempts || 0) + 1;
        if (rec.resolveAttempts < 60) {
            setTimeout(() => resolveAndAccountPnl(slug), 10_000);
        } else {
            logger.warn(`btc5m: ${slug} resolve gave up after 60 attempts — ${e.message}`);
            _pendingResolution.delete(slug);
        }
    }
}

async function onNewRound(roundTs) {
    resetDailyIfNewUtcDay();

    if (!DRY_RUN && DAILY_LOSS_LIMIT > 0 && _dailyPnl <= -DAILY_LOSS_LIMIT) {
        logger.warn(`btc5m: daily loss limit hit (${_dailyPnl.toFixed(2)}) — skipping round`);
        return;
    }

    if (_candles.length < SEQ_LEN) {
        logger.warn(`btc5m: not enough candles (${_candles.length}/${SEQ_LEN}) — skipping`);
        return;
    }

    const slug = `btc-updown-5m-${roundTs}`;
    logger.info(`btc5m: ── NEW ROUND ${slug} @ $${PRICE.value?.toFixed(1)} ──`);

    // 1. Predict
    const seq = buildFeatureSeq();
    const pred = await predict(seq);
    if (!pred) { logger.warn('btc5m: no prediction'); return; }
    logger.info(`btc5m: pred_up=${pred.pred_up.toFixed(3)} pred_dn=${pred.pred_dn.toFixed(3)}`);

    // 2. Get market + current asks
    const market = await fetchMarketBySlug(slug);
    if (!market) { logger.warn(`btc5m: market not found for ${slug}`); return; }

    const [upAsk, dnAsk] = await Promise.all([
        fetchBook(market.upTokenId),
        fetchBook(market.dnTokenId),
    ]);
    if (upAsk === null || dnAsk === null) {
        logger.warn(`btc5m: missing asks up=${upAsk} dn=${dnAsk}`);
        return;
    }
    logger.info(`btc5m: up_ask=${upAsk} dn_ask=${dnAsk} pred_up=${pred.pred_up.toFixed(3)} pred_dn=${pred.pred_dn.toFixed(3)}`);

    // 3. Build full passive grid on BOTH sides — flat sizing, no EV gate
    let upRungs = computeGridRungs('UP', upAsk, market.tickSize);
    let dnRungs = computeGridRungs('DN', dnAsk, market.tickSize);

    if (upRungs.length === 0 && dnRungs.length === 0) {
        logger.warn(`btc5m: no passive rungs available (asks too low?) up_ask=${upAsk} dn_ask=${dnAsk} — skipping round`);
        return;
    }

    // 3.1 Skew rung counts by model confidence: favored side keeps full grid,
    // hedge side trimmed to max(0.25, pred_hedge/pred_favored). This wires the
    // model prediction into actual order sizing for the first time.
    {
        const MIN_HEDGE_RATIO = 0.25;
        const predUp = pred.pred_up;
        const predDn = pred.pred_dn;
        if (Math.abs(predUp - predDn) > 0.01) {
            const [favSide, hedgeSide] = predUp >= predDn ? ['up', 'dn'] : ['dn', 'up'];
            const predFav   = predUp >= predDn ? predUp : predDn;
            const predHedge = predUp >= predDn ? predDn : predUp;
            const hedgeRatio = Math.max(MIN_HEDGE_RATIO, predHedge / predFav);
            if (hedgeSide === 'dn') {
                const keep = Math.max(1, Math.round(dnRungs.length * hedgeRatio));
                dnRungs = dnRungs.slice(0, keep);
            } else {
                const keep = Math.max(1, Math.round(upRungs.length * hedgeRatio));
                upRungs = upRungs.slice(0, keep);
            }
            logger.info(`btc5m: grid skew fav=${favSide.toUpperCase()} hedgeRatio=${hedgeRatio.toFixed(2)} → ${upRungs.length}UP/${dnRungs.length}DN rungs`);
        }
    }

    // 3.5 Order-flow signal — observation only. Never skips a side.
    // The signal feeds the chase simulator in pollAndHedge to inform hedge urgency.
    const flowSig = _flow.compute(Date.now());
    const rec     = recommendMode(flowSig);
    logger.info(`btc5m: signal flow3s=${flowSig.flow3s} flow30s=${flowSig.flow30s} bias3s=${flowSig.bias3s} bias30s=${flowSig.bias30s} trades30s=${flowSig.trades30s} → ${rec.mode} (${rec.reason})`);
    appendJsonl(TRADES_LOG, { ts: Date.now(), event: 'signal', slug, ...flowSig, rec_mode: rec.mode, rec_reason: rec.reason });
    _active.signalMode = rec.mode;

    // 4. Place all rungs (sequential to avoid rate limits)
    for (const rung of upRungs) await placeRung(market, market.upTokenId, rung);
    for (const rung of dnRungs) await placeRung(market, market.dnTokenId, rung);

    // 5. Store rungs + open asks for fill simulation at resolution time.
    _pendingResolution.set(slug, {
        upRungs, dnRungs, upOpenAsk: upAsk, dnOpenAsk: dnAsk,
        trackedUpFills: null, trackedDnFills: null, resolveAttempts: 0,
    });

    const totalSh = upRungs.reduce((a,r) => a+r.shares, 0) + dnRungs.reduce((a,r) => a+r.shares, 0);
    const totalCost = upRungs.reduce((a,r) => a+r.shares*r.price, 0) + dnRungs.reduce((a,r) => a+r.shares*r.price, 0);
    logger.info(`btc5m: round orders placed — ${upRungs.length}UP + ${dnRungs.length}DN, total=${totalSh}sh max_exposure=$${totalCost.toFixed(2)}`);

    // 6. Start mid-round hedge monitor — polls book every POLL_SEC seconds.
    // Order IDs were collected during placeRung calls above (when !DRY_RUN).
    const collectedUpIds = [..._active.upOrderIds];
    const collectedDnIds = [..._active.dnOrderIds];
    _clearActive();
    Object.assign(_active, { slug, market, upBids: upRungs, dnBids: dnRungs,
        upOrderIds: collectedUpIds, dnOrderIds: collectedDnIds, signalMode: rec.mode,
        initialPred: pred, lastMidInferTs: 0 });
    _active.timer = setInterval(pollAndHedge, POLL_SEC * 1000);

    // At round end: copy tracked fills into pending resolution, then clear monitor.
    setTimeout(() => {
        if (_active.slug === slug) {
            const rec = _pendingResolution.get(slug);
            if (rec) {
                rec.trackedUpFills = [..._active.upFilled];
                rec.trackedDnFills = [..._active.dnFilled];
            }
            _clearActive();
        }
    }, ROUND_SEC * 1000);

    // Schedule PnL resolution 60s after round end (Chainlink usually resolves within 30-60s)
    setTimeout(() => resolveAndAccountPnl(slug), (ROUND_SEC + 60) * 1000);
}

function tick() {
    const rts = Math.floor(Date.now() / 1000 / ROUND_SEC) * ROUND_SEC;
    const secIntoRound = Math.floor(Date.now() / 1000) - rts;

    if (rts === _lastRoundTs) return;
    if (secIntoRound > ENTRY_WINDOW_SEC) {
        logger.warn(`btc5m: skipping round ${rts} — already ${secIntoRound}s in (> ENTRY_WINDOW_SEC=${ENTRY_WINDOW_SEC})`);
        _lastRoundTs = rts;  // mark seen so we don't re-log
        return;
    }
    _lastRoundTs = rts;
    onNewRound(rts).catch(err => logger.error(`btc5m: round handler error — ${err.message}`));
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════════

async function main() {
    logger.info(`btc5m: starting execution bot (DRY_RUN=${DRY_RUN})`);
    logger.info(`btc5m: unit_shares=${UNIT_SHARES} max_rungs=${MAX_RUNGS} grid=${GRID_MIN}-${GRID_MAX} step=${GRID_STEP}`);

    if (!DRY_RUN) {
        if (!config.privateKey || !config.proxyWallet) {
            logger.error('btc5m: PRIVATE_KEY and PROXY_WALLET_ADDRESS required in live mode');
            process.exit(1);
        }
        // Initialize CLOB client in live mode
        await initClient();
        logger.info('btc5m: CLOB client ready');
    }

    await loadModel();
    await prefillCandles();
    connectBinance();

    // Tick every 1s — round boundary detected within that granularity
    setInterval(tick, 1000);
    logger.info(`btc5m: entering round loop (entry window: first ${ENTRY_WINDOW_SEC}s)`);
}

main().catch(err => { logger.error(`btc5m fatal: ${err.stack || err}`); process.exit(1); });
