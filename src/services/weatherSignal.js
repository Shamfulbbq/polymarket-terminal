/**
 * weatherSignal.js — Polymarket weather market signal computation.
 *
 * Ported from weather_bot_V1/src/signal.js — all temperatures in °C.
 *
 * Model: P(max_temp = T | forecast) ~ Normal(μ=ensembleMean, σ=sigma)
 *   P(bucket T exactly)  = Φ((T+0.5 - μ)/σ) - Φ((T-0.5 - μ)/σ)
 *   P("T or above")      = 1 - Φ((T-0.5 - μ)/σ)
 *   P("T or below")      = Φ((T+0.5 - μ)/σ)
 *
 * Edge  = signal_prob - market_price
 * Kelly = 0.5 * edge / (1 - market_price)  [half-Kelly, capped at 20% of bankroll]
 *
 * Solar adjustment: clear sky (+0.5°C μ), overcast (-0.5°C μ)
 * Wind adjustment:  strong wind → σ += 0.5°C
 *
 * Fee awareness (V4): gross edge is reduced by estimated taker fee before
 * comparing against MIN_EDGE. Fee loaded from feeSchedule.js.
 */

import { computeFee } from './feeSchedule.js';

// ── Normal distribution helpers ──────────────────────────────────────────────

/** Error function (Abramowitz & Stegun 7.1.26, max err 1.5e-7) */
function erf(x) {
    const sign = x >= 0 ? 1 : -1;
    x = Math.abs(x);
    const a1 =  0.254829592, a2 = -0.284496736, a3 =  1.421413741;
    const a4 = -1.453152027, a5 =  1.061405429, p  =  0.3275911;
    const t = 1 / (1 + p * x);
    const y = 1 - (((((a5*t + a4)*t + a3)*t + a2)*t + a1)*t) * Math.exp(-x*x);
    return sign * y;
}

/** Standard normal CDF: Φ(z) */
function normCDF(z) {
    return 0.5 * (1 + erf(z / Math.SQRT2));
}

// ── Signal computation ────────────────────────────────────────────────────────

/**
 * Compute probability + edge for each market bucket.
 * @param {object} wx      - { ensembleMean, sigma, cloudCover, solarRad, windSpeed } — all °C
 * @param {Array}  markets - [{ tempC, isAbove, isBelow, yesPrice, ... }]
 * @returns {Array} markets with .signalProb and .edge added
 */
export function computeSignal(wx, markets) {
    let mu    = wx.ensembleMean;
    let sigma = wx.sigma;

    // Solar + cloud adjustment to μ
    if (wx.solarRad !== null && wx.solarRad !== undefined &&
        wx.cloudCover !== null && wx.cloudCover !== undefined) {
        if (wx.solarRad > 15 && wx.cloudCover < 50) mu    += 0.5;
        if (wx.solarRad < 5  && wx.cloudCover > 90) mu    -= 0.5;
    }

    // Wind adjustment to σ (coastal mixing)
    if (wx.windSpeed !== null && wx.windSpeed !== undefined && wx.windSpeed > 20) {
        sigma += 0.5;
    }

    return markets.map(m => {
        const T = m.tempC;
        let signalProb;

        if (m.isAbove) {
            signalProb = 1 - normCDF((T - 0.5 - mu) / sigma);
        } else if (m.isBelow) {
            signalProb = normCDF((T + 0.5 - mu) / sigma);
        } else {
            signalProb = normCDF((T + 0.5 - mu) / sigma) - normCDF((T - 0.5 - mu) / sigma);
        }

        const edge = signalProb - (m.yesPrice || 0);

        return {
            ...m,
            signalProb: round2(signalProb),
            edge:       round2(edge),
            mu:         round2(mu),
            sigma:      round2(sigma),
        };
    });
}

// ── Bracket recommendation ────────────────────────────────────────────────────

const MIN_EDGE              = 0.07;  // 7¢ minimum edge (V4: raised from 5¢ to absorb weather taker fees)
const MIN_EDGE_OVERCONFIDENT = 0.10; // 10¢ edge required when sigma < 2°C (V3: overconfidence guard)
const SIGMA_OVERCONFIDENT   = 2.0;  // sigma threshold below which stricter edge applies
const MAX_LEGS       = 2;     // max buckets per city (V3: reduced from 3 to limit concentration)
const HALF_KELLY_CAP = 0.20;  // cap at 20% bankroll per leg
const MAX_DEPLOY     = 0.80;  // never deploy more than 80% total

/**
 * Recommend bracket trades using half-Kelly sizing.
 * @param {Array}  markets     - output of computeSignal (with .edge)
 * @param {number} bankroll    - available USDC
 * @param {Array}  existingPos - conditionIds already held
 * @returns {Array} [{ conditionId, yesTokenId, noTokenId, tempC, isAbove, isBelow,
 *                     yesPrice, signalProb, edge, shares, cost }]
 */
export function recommendBracket(markets, bankroll, existingPos = []) {
    const heldIds = new Set((existingPos || []).map(p => p.conditionId));

    const candidates = markets
        .filter(m => {
            if (heldIds.has(m.conditionId)) return false;
            if ((m.yesPrice || 0) < 0.005) return false;
            // V4: subtract estimated taker fee from gross edge
            const feePerShare = computeFee(1, m.yesPrice, 'weather');
            const netEdge = m.edge - feePerShare;
            // V3 overconfidence guard: tighter edge requirement when sigma is low
            const minEdge = (m.sigma !== undefined && m.sigma < SIGMA_OVERCONFIDENT)
                ? MIN_EDGE_OVERCONFIDENT
                : MIN_EDGE;
            return netEdge >= minEdge;
        })
        .sort((a, b) => b.edge - a.edge)
        .slice(0, MAX_LEGS);

    if (candidates.length === 0) return [];

    const deployable = bankroll * MAX_DEPLOY;

    return candidates.map(m => {
        const kelly   = 0.5 * m.edge / (1 - m.yesPrice);
        const dollars = Math.min(
            bankroll * Math.min(kelly, HALF_KELLY_CAP),
            deployable / candidates.length
        );
        const shares = Math.floor(dollars / m.yesPrice);
        const cost   = round2(shares * m.yesPrice);

        return { ...m, shares, cost };
    }).filter(t => t.shares > 0 && t.cost > 0);
}

// ── Formatting ────────────────────────────────────────────────────────────────

export function formatSignalSummary(city, wx, markets) {
    const top3 = [...markets].sort((a, b) => b.signalProb - a.signalProb).slice(0, 3);
    const lines = [
        `  μ=${wx.ensembleMean?.toFixed(1)}°C (GFS ${wx.gfsTmax?.toFixed(1)} / ECMWF ${wx.ecmwfTmax?.toFixed(1)})` +
        (wx.mlPredC !== undefined ? `  ML=${wx.mlPredC?.toFixed(1)}°C` : '') +
        `  σ=${markets[0]?.sigma ?? '?'}°C`,
        `  ☀️  solar=${wx.solarRad?.toFixed(1)} MJ/m²  ☁️  cloud=${wx.cloudCover?.toFixed(0)}%  💨 wind=${wx.windSpeed?.toFixed(1)} km/h`,
        `  Buckets: ` + top3.map(m =>
            `${m.tempC}°C${m.isAbove ? '+' : ''} sig=${pct(m.signalProb)} mkt=${pct(m.yesPrice)} edge=${signed(m.edge)}`
        ).join('  |  '),
    ];
    return lines.join('\n');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const round2 = n => Math.round(n * 100) / 100;
const pct    = n => (n * 100).toFixed(1) + '%';
const signed = n => (n >= 0 ? '+' : '') + (n * 100).toFixed(1) + '¢';
