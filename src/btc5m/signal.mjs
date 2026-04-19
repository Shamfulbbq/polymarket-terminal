/**
 * signal.mjs
 *
 * Order-flow imbalance signals for the btc5m grid bot.
 *
 * Two trackers, both pure / no I/O:
 *
 *   FlowTracker     — Binance BTC spot taker-buy ratio over rolling windows.
 *                     Leading indicator: when taker-buy ratio collapses, BTC
 *                     spot is being sold aggressively, which drags Polymarket
 *                     UP price down ~1-2s later.
 *
 *   BookDeltaTracker — Polymarket up_ask / dn_ask velocity over rolling
 *                     windows. Reacts to PM-side flow directly. Useful as a
 *                     confirmation signal (when both BTC flow AND PM book
 *                     point the same way, conviction is high).
 *
 * Output of computeFlow(now) / computeBookDelta(now):
 *
 *   {
 *     flow3s,  flow30s,    // taker-buy ratio in [0,1]; 0.5 = balanced
 *     trades3s, trades30s, // raw trade count (sanity check — too few = noisy)
 *     vol3s,   vol30s,     // total BTC volume in window
 *     bias3s,  bias30s,    // signed: 2*flow - 1, in [-1,+1] (negative = sell pressure)
 *   }
 *
 *   {
 *     upAskDelta3s, upAskDelta30s,   // change in best UP ask over window
 *     dnAskDelta3s, dnAskDelta30s,   // change in best DN ask over window
 *     spreadDelta3s, spreadDelta30s, // change in (up_ask + dn_ask)
 *   }
 *
 * Both buffers self-trim — no memory growth.
 */

const FLOW_WINDOWS_SEC = [1, 3, 30];   // match URL bot UI
const BOOK_WINDOWS_SEC = [3, 30];

// Keep a generous safety margin in the buffer so the longest window always
// has data even if ticks arrive slightly late.
const FLOW_BUFFER_SEC = 60;
const BOOK_BUFFER_SEC = 60;

// ── Binance taker-buy flow tracker ────────────────────────────────────────────

export class FlowTracker {
    constructor() {
        // ring buffer-ish: just a plain array, trimmed on add.
        // entries: { ts: ms, qty: number, takerBuy: bool }
        this._trades = [];
    }

    /**
     * Push a Binance aggTrade event.
     * @param {number} qtyBase  base-asset quantity (BTC)
     * @param {boolean} isBuyerMaker  true => taker SOLD, false => taker BOUGHT
     * @param {number} tsMs
     */
    addTrade(qtyBase, isBuyerMaker, tsMs, price = null) {
        if (!Number.isFinite(qtyBase) || qtyBase <= 0) return;
        this._trades.push({ ts: tsMs, qty: qtyBase, takerBuy: !isBuyerMaker, price });
        // Trim anything older than buffer
        const cutoff = tsMs - FLOW_BUFFER_SEC * 1000;
        // Cheap incremental trim — most trades are appended in order
        while (this._trades.length && this._trades[0].ts < cutoff) {
            this._trades.shift();
        }
    }

    /**
     * @param {number} nowMs
     * @returns {object|null}
     */
    compute(nowMs) {
        const out = {};
        for (const w of FLOW_WINDOWS_SEC) {
            const cutoff = nowMs - w * 1000;
            let buyVol = 0, sellVol = 0, totalVol = 0, count = 0;
            let pxQtySum = 0, pxQtyCount = 0;
            for (let i = this._trades.length - 1; i >= 0; i--) {
                const t = this._trades[i];
                if (t.ts < cutoff) break;
                totalVol += t.qty;
                if (t.takerBuy) buyVol += t.qty; else sellVol += t.qty;
                if (t.price != null) { pxQtySum += t.price * t.qty; pxQtyCount += t.qty; }
                count++;
            }
            const flow = totalVol > 0 ? buyVol / totalVol : 0.5;
            const vwap = pxQtyCount > 0 ? pxQtySum / pxQtyCount : null;
            out[`flow${w}s`]    = +flow.toFixed(4);
            out[`bias${w}s`]    = +(2 * flow - 1).toFixed(4);
            out[`vol${w}s`]     = +totalVol.toFixed(6);
            out[`trades${w}s`]  = count;
            out[`buyVol${w}s`]  = +buyVol.toFixed(6);
            out[`sellVol${w}s`] = +sellVol.toFixed(6);
            out[`vwap${w}s`]    = vwap != null ? +vwap.toFixed(4) : null;
        }
        return out;
    }
}

// ── Polymarket book-delta tracker ─────────────────────────────────────────────

export class BookDeltaTracker {
    constructor() {
        // entries: { ts: ms, upAsk: number|null, dnAsk: number|null }
        this._snaps = [];
    }

    /**
     * @param {number|null} upAsk
     * @param {number|null} dnAsk
     * @param {number} tsMs
     */
    addSnap(upAsk, dnAsk, tsMs) {
        this._snaps.push({ ts: tsMs, upAsk, dnAsk });
        const cutoff = tsMs - BOOK_BUFFER_SEC * 1000;
        while (this._snaps.length && this._snaps[0].ts < cutoff) {
            this._snaps.shift();
        }
    }

    /**
     * Find oldest snap that is >= (nowMs - windowSec*1000).
     * That snap's value is the "windowSec ago" baseline.
     */
    _baselineSnap(nowMs, windowSec) {
        const cutoff = nowMs - windowSec * 1000;
        // Linear scan — buffer is at most ~60 entries at 1s tick
        for (let i = 0; i < this._snaps.length; i++) {
            if (this._snaps[i].ts >= cutoff) return this._snaps[i];
        }
        return null;
    }

    compute(nowMs) {
        if (this._snaps.length === 0) return null;
        const latest = this._snaps[this._snaps.length - 1];
        const out = {};
        for (const w of BOOK_WINDOWS_SEC) {
            const base = this._baselineSnap(nowMs, w);
            const dUp = (base && base.upAsk != null && latest.upAsk != null)
                ? +(latest.upAsk - base.upAsk).toFixed(4) : null;
            const dDn = (base && base.dnAsk != null && latest.dnAsk != null)
                ? +(latest.dnAsk - base.dnAsk).toFixed(4) : null;
            const dSpread = (dUp != null && dDn != null)
                ? +(dUp + dDn).toFixed(4) : null;
            out[`upAskDelta${w}s`]   = dUp;
            out[`dnAskDelta${w}s`]   = dDn;
            out[`spreadDelta${w}s`]  = dSpread;
        }
        return out;
    }
}

// ── Decision helper (pure) ────────────────────────────────────────────────────

/**
 * Given the latest signal snapshot, produce a recommendation for grid placement.
 *
 * The original target bot NEVER skips a round — it always places both sides
 * and chases the lagging hedge as the round runs down. The signal only biases
 * which side leads and how aggressive the chase needs to be.
 *
 * Returns one of:
 *   { mode: 'BALANCED'   }  — flow neutral
 *   { mode: 'LEAN_UP'    }  — mild UP bias
 *   { mode: 'LEAN_DN'    }  — mild DN bias
 *   { mode: 'STRONG_UP'  }  — strong UP bias (chase DN harder later)
 *   { mode: 'STRONG_DN'  }  — strong DN bias (chase UP harder later)
 */
export function recommendMode({ flow3s, flow30s, bias3s, bias30s, trades30s }) {
    if (trades30s == null || trades30s < 20) return { mode: 'BALANCED', reason: 'low_volume' };

    const STRONG = 0.40;   // |bias| >= 0.40 → flow ratio >= 0.70 or <= 0.30
    const MILD   = 0.20;   // |bias| >= 0.20 → flow ratio >= 0.60 or <= 0.40

    if (bias30s <= -STRONG && bias3s <= -STRONG) return { mode: 'STRONG_DN', reason: `bias30s=${bias30s} bias3s=${bias3s}` };
    if (bias30s >=  STRONG && bias3s >=  STRONG) return { mode: 'STRONG_UP', reason: `bias30s=${bias30s} bias3s=${bias3s}` };
    if (bias30s <= -MILD   && bias3s <= -MILD)   return { mode: 'LEAN_DN',   reason: 'mild_dn' };
    if (bias30s >=  MILD   && bias3s >=  MILD)   return { mode: 'LEAN_UP',   reason: 'mild_up' };
    return { mode: 'BALANCED', reason: 'no_clear_trend' };
}
