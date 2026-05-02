/**
 * bot_v7.mjs — BTC UP/DN 5-min, gamma-scalper (calibration fade)
 *
 * Strategy: When the crowd prices one side at ≥ ENTRY_THRESH (e.g. 0.73),
 * calibration data shows the actual probability is 51-53% — the crowd
 * massively overprices momentum. We buy the UNDERDOG side as a taker (FAK),
 * then scale in if the underdog gets even cheaper (< SCALE_THRESH).
 *
 * Key differences from V6 (maker straddle):
 *  - Taker execution: fills at current ask immediately (no GTC bid/reprice loop)
 *  - Entry only when crowd is at extremes (one side ≥ ENTRY_THRESH)
 *  - Directional: buy underdog only. No automatic hedge.
 *  - Scale-in: buy more underdog when it drops below SCALE_THRESH
 *  - State machine per round: idle → entered → done
 *
 * Calibration source: directional-bot/data/pm_calibration_midmarket.json
 *   n=3000+ rounds; when UP ask ≥ 0.60, actual P(UP) = 53.2% (crowd overpays)
 *
 * Usage:
 *   BTC5M_DRY_RUN=true node src/btc5m/bot_v7.mjs   (default — shadow run)
 *   BTC5M_DRY_RUN=false node src/btc5m/bot_v7.mjs  (live trading)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';
import { Side, OrderType } from '@polymarket/clob-client-v2';
import config from '../config/index.js';
import { initClient, getClient, submitOrderTimed } from '../services/clientV2.js';
import logger from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..', '..');
const DATA_DIR  = path.join(ROOT, 'data', 'btc5m');
fs.mkdirSync(DATA_DIR, { recursive: true });

const TRADES_LOG    = path.join(DATA_DIR, 'bot_v7_trades.jsonl');
const DAILY_PNL_LOG = path.join(DATA_DIR, 'bot_v7_daily_pnl.jsonl');

// ══════════════════════════════════════════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════════════════════════════════════════

const DRY_RUN          = process.env.BTC5M_DRY_RUN !== 'false';
const UNIT_SHARES      = parseFloat(process.env.BTC5M_UNIT_SHARES      || '5');
const DAILY_LOSS_LIMIT = parseFloat(process.env.BTC5M_DAILY_LOSS_LIMIT || '30');
const ENTRY_THRESH     = parseFloat(process.env.BTC5M_ENTRY_THRESH     || '0.73'); // crowd must price one side ≥ this
const ENTRY_EV_THRESH  = parseFloat(process.env.BTC5M_ENTRY_EV         || '0.03'); // min calibrated EV to enter
const SCALE_THRESH     = parseFloat(process.env.BTC5M_SCALE_THRESH     || '0.15'); // scale-in when underdog falls here
const MAX_SCALE        = parseInt(  process.env.BTC5M_MAX_SCALE        || '3', 10);
const ENTRY_WINDOW_SEC = parseInt(  process.env.BTC5M_ENTRY_WINDOW_SEC || '240', 10); // allow entry for first N secs of round
const TICK_MS          = parseInt(  process.env.BTC5M_TICK_MS          || '5000', 10);
const MIN_PRICE        = 0.02;
const MAX_PRICE        = 0.98;
const ROUND_SEC        = 300;
const GAMMA_HOST       = config.gammaHost;
const CLOB_HOST        = config.clobHost;

// V2 (post Apr 28 2026): maker fee = 0%, taker fee per-market (~1-2¢ on $1 token)
const POLYMARKET_FEE   = parseFloat(process.env.BTC5M_POLYMARKET_FEE || '0.01'); // taker fee

// ══════════════════════════════════════════════════════════════════════════════
// CALIBRATION TABLE
// Source: directional-bot pm_calibration_midmarket.json (n=3000+ per bucket)
// When YES (UP ask) crosses threshold mid-round, actual P(UP) at resolution = p_up.
// The crowd overprices momentum — actual P(UP) is only 51-53% even at 80%+ ask.
// ══════════════════════════════════════════════════════════════════════════════

const CALIB = [
    { thr: 0.60, p_up: 0.532 },
    { thr: 0.65, p_up: 0.528 },
    { thr: 0.70, p_up: 0.522 },
    { thr: 0.75, p_up: 0.515 },
    { thr: 0.80, p_up: 0.513 },
];

// Returns calibrated P(UP) when the market is at an extreme. Returns null if
// neither side is extreme enough to apply the calibration.
function calibratedPUp(upAsk, dnAsk) {
    if (upAsk >= ENTRY_THRESH) {
        let best = null;
        for (const c of CALIB) if (upAsk >= c.thr) best = c;
        if (best) return best.p_up; // UP is overpriced; actual P(UP) = 51-53%
    }
    if (dnAsk >= ENTRY_THRESH) {
        let best = null;
        for (const c of CALIB) if (dnAsk >= c.thr) best = c;
        if (best) return 1 - best.p_up; // DN is overpriced; actual P(UP) is high
    }
    return null;
}

// Returns entry signal: which side to BUY (underdog) and its calibrated EV.
function entrySignal(upAsk, dnAsk) {
    const pUp = calibratedPUp(upAsk, dnAsk);
    if (pUp === null) return null;

    if (upAsk >= ENTRY_THRESH) {
        // UP is favored/overpriced. Buy DN (underdog).
        const pDn = 1 - pUp;
        const ev  = pDn * (1 - POLYMARKET_FEE) - dnAsk;
        if (ev < ENTRY_EV_THRESH) return null;
        return { side: 'DN', ask: dnAsk, ev, pWin: pDn };
    }
    if (dnAsk >= ENTRY_THRESH) {
        // DN is favored/overpriced. Buy UP (underdog).
        const ev = pUp * (1 - POLYMARKET_FEE) - upAsk;
        if (ev < ENTRY_EV_THRESH) return null;
        return { side: 'UP', ask: upAsk, ev, pWin: pUp };
    }
    return null;
}

// ══════════════════════════════════════════════════════════════════════════════
// BINANCE PRICE FEED
// ══════════════════════════════════════════════════════════════════════════════

const PRICE = { value: null };

function connectBinance() {
    const ws = new WebSocket('wss://stream.binance.com:9443/stream?streams=btcusdt@aggTrade');
    ws.on('open',  () => logger.info('btc5m-v7: Binance WS connected'));
    ws.on('close', () => { logger.warn('btc5m-v7: Binance WS closed, reconnect 5s'); setTimeout(connectBinance, 5000); });
    ws.on('error', err => logger.warn(`btc5m-v7: Binance WS error: ${err.message}`));
    ws.on('message', raw => {
        try {
            const msg = JSON.parse(raw);
            if (msg.data?.p) PRICE.value = parseFloat(msg.data.p);
        } catch { /* ignore */ }
    });
}

// ══════════════════════════════════════════════════════════════════════════════
// POLYMARKET HELPERS
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
            upTokenId:   tokens[0],
            dnTokenId:   tokens[1],
            negRisk:     !!m.negRisk,
            tickSize:    m.orderPriceMinTickSize ? parseFloat(m.orderPriceMinTickSize) : 0.01,
        };
    } catch { return null; }
}

async function fetchAsks(market) {
    try {
        const [upResp, dnResp] = await Promise.all([
            fetch(`${CLOB_HOST}/book?token_id=${market.upTokenId}`, { signal: AbortSignal.timeout(3000) }),
            fetch(`${CLOB_HOST}/book?token_id=${market.dnTokenId}`, { signal: AbortSignal.timeout(3000) }),
        ]);
        if (!upResp.ok || !dnResp.ok) return null;
        const [upBook, dnBook] = await Promise.all([upResp.json(), dnResp.json()]);
        const upAsk = (upBook.asks || []).at(-1)?.price;
        const dnAsk = (dnBook.asks || []).at(-1)?.price;
        if (!upAsk || !dnAsk) return null;
        return { upAsk: parseFloat(upAsk), dnAsk: parseFloat(dnAsk) };
    } catch { return null; }
}

function appendJsonl(file, obj) {
    try { fs.appendFileSync(file, JSON.stringify(obj) + '\n'); }
    catch (e) { logger.warn(`btc5m-v7: log append failed — ${e.message}`); }
}

// ══════════════════════════════════════════════════════════════════════════════
// ORDER PLACEMENT (TAKER)
// Place at ask + slippage to cross the book immediately.
// ══════════════════════════════════════════════════════════════════════════════

async function placeTakerOrder(market, side, ask, shares) {
    const tokenId = side === 'UP' ? market.upTokenId : market.dnTokenId;
    // Clamp to valid range
    if (ask < MIN_PRICE || ask > MAX_PRICE) return null;

    if (DRY_RUN) {
        logger.info(`btc5m-v7 [DRY] TAKER ${side} ${shares}sh @${ask}`);
        appendJsonl(TRADES_LOG, { ts: Date.now(), event: 'fill', dry: true,
            slug: _r.slug, side, price: ask, shares });
        return { price: ask, shares };
    }

    // Live: place limit order at ask + 2 ticks to ensure immediate fill
    const takerPrice = +(Math.min(MAX_PRICE,
        Math.round((ask + 0.02) / market.tickSize) * market.tickSize
    ).toFixed(3));

    try {
        const { res } = await submitOrderTimed(
            { tokenID: tokenId, side: Side.BUY, price: takerPrice, size: shares },
            { tickSize: market.tickSize, negRisk: market.negRisk },
            OrderType.FOK,
        );
        if (res?.success) {
            const fillPrice = parseFloat(res.price || ask);
            logger.info(`btc5m-v7: TAKER ${side} ${shares}sh @${fillPrice} — ${res.orderID?.slice(0, 10)}`);
            appendJsonl(TRADES_LOG, { ts: Date.now(), event: 'fill', slug: _r.slug,
                side, price: fillPrice, shares, orderId: res.orderID });
            return { price: fillPrice, shares };
        }
        logger.warn(`btc5m-v7: TAKER ${side} rejected — ${res?.errorMsg || 'unknown'}`);
        return null;
    } catch (err) {
        logger.warn(`btc5m-v7: TAKER error — ${err.message}`);
        return null;
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// ROUND STATE
// ══════════════════════════════════════════════════════════════════════════════

const _r = {
    slug: null, market: null, roundTs: null,
    state: 'idle',    // 'idle' | 'entered' | 'done'
    side: null,       // 'UP' | 'DN' — the underdog side we bought
    fills: [],        // { price, shares }
    scaleCount: 0,
};

function _clearRound() {
    Object.assign(_r, {
        slug: null, market: null, roundTs: null,
        state: 'idle', side: null, fills: [], scaleCount: 0,
    });
}

// ══════════════════════════════════════════════════════════════════════════════
// TRADE LOOP — called every tick while a round is active
// ══════════════════════════════════════════════════════════════════════════════

async function tradeLoop() {
    if (!_r.market || _r.state === 'done') return;

    const nowSec = Math.floor(Date.now() / 1000);
    const tRem   = Math.max(0, (_r.roundTs + ROUND_SEC) - nowSec);

    if (tRem < 15) {
        // Near round end — stop trading
        _r.state = 'done';
        return;
    }

    const asks = await fetchAsks(_r.market);
    if (!asks) return;
    const { upAsk, dnAsk } = asks;

    if (_r.state === 'idle') {
        if (tRem < ROUND_SEC - ENTRY_WINDOW_SEC) return; // past entry window

        const sig = entrySignal(upAsk, dnAsk);
        if (!sig) {
            // Log once per 30s to avoid spam
            if (tRem % 30 < 6) logger.info(`btc5m-v7: ${_r.slug} watching up=${upAsk} dn=${dnAsk} t=${tRem}s (no extreme)`);
            return;
        }

        logger.info(`btc5m-v7: ${_r.slug} ENTER ${sig.side} @${sig.ask} ev=${sig.ev.toFixed(3)} pWin=${sig.pWin.toFixed(3)} up=${upAsk} dn=${dnAsk} t=${tRem}s btc=${PRICE.value?.toFixed(1) ?? '?'}`);
        appendJsonl(TRADES_LOG, { ts: Date.now(), event: 'enter', slug: _r.slug,
            side: sig.side, ask: sig.ask, ev: +sig.ev.toFixed(4), pWin: +sig.pWin.toFixed(4),
            up_ask: upAsk, dn_ask: dnAsk, t_rem: tRem });

        const fill = await placeTakerOrder(_r.market, sig.side, sig.ask, UNIT_SHARES);
        if (!fill) return;

        _r.fills.push(fill);
        _r.side  = sig.side;
        _r.state = 'entered';
        return;
    }

    if (_r.state === 'entered') {
        const undergodAsk = _r.side === 'DN' ? dnAsk : upAsk;

        if (undergodAsk <= SCALE_THRESH && _r.scaleCount < MAX_SCALE && tRem > 30) {
            logger.info(`btc5m-v7: ${_r.slug} SCALE-IN ${_r.side} @${undergodAsk} (n=${_r.scaleCount + 1}) t=${tRem}s`);
            appendJsonl(TRADES_LOG, { ts: Date.now(), event: 'scale', slug: _r.slug,
                side: _r.side, ask: undergodAsk, scale_n: _r.scaleCount + 1, t_rem: tRem });
            const fill = await placeTakerOrder(_r.market, _r.side, undergodAsk, UNIT_SHARES);
            if (fill) {
                _r.fills.push(fill);
                _r.scaleCount++;
            }
        } else {
            const totalSh  = _r.fills.reduce((a, f) => a + f.shares, 0);
            const avgPrice = _r.fills.reduce((a, f) => a + f.price * f.shares, 0) / totalSh;
            logger.info(`btc5m-v7: ${_r.slug} holding ${_r.side} ${totalSh}sh avg=${avgPrice.toFixed(3)} under_ask=${undergodAsk.toFixed(3)} t=${tRem}s`);
        }
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// NEW ROUND HANDLER
// ══════════════════════════════════════════════════════════════════════════════

async function onNewRound(roundTs) {
    resetDailyIfNewDay();

    if (!DRY_RUN && DAILY_LOSS_LIMIT > 0 && _dailyPnl <= -DAILY_LOSS_LIMIT) {
        logger.warn(`btc5m-v7: daily loss limit (${_dailyPnl.toFixed(2)}) — paused`);
        return;
    }

    const slug = `btc-updown-5m-${roundTs}`;
    logger.info(`btc5m-v7: ── NEW ROUND ${slug} btc=$${PRICE.value?.toFixed(1) ?? '?'} ──`);

    const market = await fetchMarketBySlug(slug);
    if (!market) { logger.warn(`btc5m-v7: market not found ${slug}`); return; }

    _clearRound();
    _r.slug = slug; _r.market = market; _r.roundTs = roundTs;

    // Snapshot fills for PnL accounting (reference, updated live)
    _pending.set(slug, { fills: _r.fills, side: null, attempts: 0 });

    // Snapshot at round close
    setTimeout(() => {
        if (_r.slug === slug) {
            const rec = _pending.get(slug);
            if (rec) { rec.fills = [..._r.fills]; rec.side = _r.side; }
            _r.state = 'done';
        }
    }, ROUND_SEC * 1000);

    setTimeout(() => resolveAndAccountPnl(slug), (ROUND_SEC + 60) * 1000);
}

// ══════════════════════════════════════════════════════════════════════════════
// PnL ACCOUNTING
// ══════════════════════════════════════════════════════════════════════════════

let _lastRoundTs = null;
let _dailyDate   = new Date().toISOString().slice(0, 10);
let _dailyPnl    = 0;
const _pending   = new Map();

function loadDailyPnl() {
    const today = new Date().toISOString().slice(0, 10);
    _dailyDate = today; _dailyPnl = 0;
    try {
        if (!fs.existsSync(DAILY_PNL_LOG)) return;
        const lines = fs.readFileSync(DAILY_PNL_LOG, 'utf8').trim().split('\n').filter(Boolean);
        for (const l of lines) {
            const row = JSON.parse(l);
            if (row.date === today) _dailyPnl += (row.pnl || 0);
        }
        if (_dailyPnl !== 0) logger.info(`btc5m-v7: loaded daily PnL: ${_dailyPnl.toFixed(2)}`);
    } catch (e) { logger.warn(`btc5m-v7: failed to load daily PnL — ${e.message}`); }
}

function resetDailyIfNewDay() {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== _dailyDate) { _dailyDate = today; _dailyPnl = 0; logger.info('btc5m-v7: new UTC day — daily PnL reset'); }
}

async function resolveAndAccountPnl(slug) {
    const rec = _pending.get(slug);
    if (!rec) return;
    if (!rec.fills || rec.fills.length === 0) { _pending.delete(slug); return; } // no trades this round

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

        const { fills, side } = rec;
        const totalSh   = fills.reduce((a, f) => a + f.shares, 0);
        const totalCost = fills.reduce((a, f) => a + f.price * f.shares, 0);
        const avgPrice  = totalSh > 0 ? totalCost / totalSh : 0;
        const weWon     = (side === 'UP' && upWon) || (side === 'DN' && dnWon);
        const gross     = weWon ? totalSh : 0;
        const fee       = gross * POLYMARKET_FEE;
        const pnl       = gross - fee - totalCost;

        _dailyPnl += pnl;
        _pending.delete(slug);

        appendJsonl(DAILY_PNL_LOG, { date: _dailyDate, slug, pnl: +pnl.toFixed(4),
            daily_pnl: +_dailyPnl.toFixed(4), ts: Date.now() });
        appendJsonl(TRADES_LOG, { ts: Date.now(), event: 'resolve', slug,
            winner: upWon ? 'UP' : 'DN', our_side: side,
            total_shares: totalSh, avg_price: +avgPrice.toFixed(4),
            scale_fills: fills.length, gross: +gross.toFixed(2),
            fee: +fee.toFixed(2), pnl: +pnl.toFixed(4), daily_pnl: +_dailyPnl.toFixed(4) });

        const result = weWon ? 'WIN' : 'LOSS';
        logger.info(`btc5m-v7: ${slug} ${result} | side=${side} winner=${upWon ? 'UP' : 'DN'} sh=${totalSh} avg=${avgPrice.toFixed(3)} pnl=${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} daily=${_dailyPnl.toFixed(2)}`);
    } catch (e) {
        rec.attempts = (rec.attempts || 0) + 1;
        if (rec.attempts < 60) setTimeout(() => resolveAndAccountPnl(slug), 10_000);
        else { logger.warn(`btc5m-v7: ${slug} resolve gave up — ${e.message}`); _pending.delete(slug); }
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN TICK — runs every TICK_MS
// ══════════════════════════════════════════════════════════════════════════════

async function tick() {
    const nowSec     = Math.floor(Date.now() / 1000);
    const roundTs    = Math.floor(nowSec / ROUND_SEC) * ROUND_SEC;
    const secInRound = nowSec - roundTs;

    if (roundTs !== _lastRoundTs) {
        // New round boundary
        if (secInRound > ENTRY_WINDOW_SEC) {
            logger.warn(`btc5m-v7: skipping ${roundTs} — already ${secInRound}s in`);
            _lastRoundTs = roundTs;
            return;
        }
        _lastRoundTs = roundTs;
        await onNewRound(roundTs);
        return; // tradeLoop will run on next tick
    }

    // Existing round — run trade loop
    await tradeLoop();
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════════

async function main() {
    logger.info([
        'btc5m-v7: starting',
        `DRY_RUN=${DRY_RUN}`,
        `entry_thresh=${ENTRY_THRESH}`,
        `entry_ev=${ENTRY_EV_THRESH}`,
        `scale_thresh=${SCALE_THRESH}`,
        `max_scale=${MAX_SCALE}`,
        `unit_shares=${UNIT_SHARES}`,
        `entry_window=${ENTRY_WINDOW_SEC}s`,
        `taker_fee=${POLYMARKET_FEE}`,
    ].join(' '));

    loadDailyPnl();

    if (!DRY_RUN) {
        if (!config.privateKey || !config.proxyWallet) {
            logger.error('btc5m-v7: PRIVATE_KEY and PROXY_WALLET_ADDRESS required for live trading');
            process.exit(1);
        }
        await initClient();
        logger.info('btc5m-v7: CLOB client initialised');
    }

    connectBinance();

    // Warm up before first tick (let Binance connect)
    logger.info('btc5m-v7: warming up (10s)...');
    setTimeout(() => setInterval(tick, TICK_MS), 10_000);
}

main().catch(err => { logger.error(`btc5m-v7: fatal — ${err.message}`); process.exit(1); });
