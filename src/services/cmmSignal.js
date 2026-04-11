/**
 * cmmSignal.js
 * Signal evaluation module for the CMM bot.
 * Pure signal logic: feature engineering, ML inference, confidence-based sizing.
 * No I/O except ONNX model loading at startup.
 *
 * Interface:
 *   evaluate(asset, candles, orderFlow, liveData, market) →
 *     { direction, side, shares, modelScore, confidence, sizing }
 *   or null if no signal / filtered by ML.
 */

import { ALL_SIGNALS } from '../backtest/signals.js';
import { std, corrLag1, fracDiffClose } from '../utils/mathUtils.js';
import { getLastPrice, getAllCandles } from './binanceFeed.js';
import logger from '../utils/logger.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── ONNX signal quality filter (fail-open) ─────────────────────────────────
let _signalModels = {};      // asset -> ort.InferenceSession
let _ort = null;             // cached onnxruntime-node module
let _signalModelWidths = {}; // asset -> input width

// ── ML degradation tracking ────────────────────────────────────────────────
const _modelStats = new Map(); // asset -> { consecutiveNulls, recentScores: [] }
const MODEL_SCORE_WINDOW = 50;

export function getModelStats(asset) {
    return _modelStats.get(asset?.toLowerCase()) || { consecutiveNulls: 0, recentScores: [] };
}

function trackModelResult(asset, score) {
    const key = asset.toLowerCase();
    if (!_modelStats.has(key)) {
        _modelStats.set(key, { consecutiveNulls: 0, recentScores: [] });
    }
    const stats = _modelStats.get(key);

    if (score === null) {
        stats.consecutiveNulls++;
    } else {
        stats.consecutiveNulls = 0;
        stats.recentScores.push(score);
        if (stats.recentScores.length > MODEL_SCORE_WINDOW) {
            stats.recentScores.shift();
        }
    }
}

/**
 * Check if model is degraded for a given asset.
 * Returns { degraded, reason } or { degraded: false }.
 */
export function checkModelDegradation(asset, opts = {}) {
    const nullThreshold = opts.nullThreshold ?? 3;
    const scoreThreshold = opts.scoreThreshold ?? 0.3;
    const minScores = opts.minScores ?? 10;

    const stats = getModelStats(asset);

    if (stats.consecutiveNulls >= nullThreshold) {
        return {
            degraded: true,
            reason: `fail-open: ${stats.consecutiveNulls} consecutive null scores for ${asset.toUpperCase()}`,
        };
    }

    if (stats.recentScores.length >= minScores) {
        const avg = stats.recentScores.reduce((a, b) => a + b, 0) / stats.recentScores.length;
        if (avg < scoreThreshold) {
            return {
                degraded: true,
                reason: `score drift: avg score ${avg.toFixed(3)} < ${scoreThreshold} over last ${stats.recentScores.length} signals for ${asset.toUpperCase()}`,
            };
        }
    }

    return { degraded: false };
}

// ── Configuration (from environment) ────────────────────────────────────────

const CMM_SIGNAL_THRESHOLD = parseFloat(process.env.CMM_SIGNAL_THRESHOLD || '0.5');
const CMM_SIGNAL_MINUTES = parseInt(process.env.CMM_SIGNAL_MINUTES || '3', 10);
const CMM_SIGNAL_NAME = process.env.CMM_SIGNAL || 'momentum';
const CMM_SHARES = parseFloat(process.env.CMM_SHARES || '20');
const CMM_MAX_SKEW_SHARES = parseFloat(process.env.CMM_MAX_SKEW_SHARES || String(CMM_SHARES * 2));
const CMM_SIZE_LOW_MULT = parseFloat(process.env.CMM_SIZE_LOW_MULT || '0.70');
const CMM_SIZE_MID_MULT = parseFloat(process.env.CMM_SIZE_MID_MULT || '1.00');
const CMM_SIZE_HIGH_MULT = parseFloat(process.env.CMM_SIZE_HIGH_MULT || '1.40');
const SLOT_SEC = 5 * 60;

// Confidence bands map to selectivity buckets from research:
// BTC: 0.55(30+ trades/day), 0.56(20+), 0.58(10+)
// ETH: 0.54(30+ trades/day), 0.55(20+), 0.57(10+)
const CMM_CONF_BANDS = {
    btc: {
        low: parseFloat(process.env.CMM_BTC_LOW_CONF || '0.55'),
        mid: parseFloat(process.env.CMM_BTC_MID_CONF || '0.56'),
        high: parseFloat(process.env.CMM_BTC_HIGH_CONF || '0.58'),
    },
    eth: {
        low: parseFloat(process.env.CMM_ETH_LOW_CONF || '0.54'),
        mid: parseFloat(process.env.CMM_ETH_MID_CONF || '0.55'),
        high: parseFloat(process.env.CMM_ETH_HIGH_CONF || '0.57'),
    },
    default: {
        low: parseFloat(process.env.CMM_DEFAULT_LOW_CONF || '0.55'),
        mid: parseFloat(process.env.CMM_DEFAULT_MID_CONF || '0.56'),
        high: parseFloat(process.env.CMM_DEFAULT_HIGH_CONF || '0.58'),
    },
};

// ── Feature columns (must match training) ───────────────────────────────────

const SIGNAL_FEATURE_COLS = [
    'obi', 'cvd_direction', 'confidence',
    'direction',
    'slot_duration', 'yes_mid', 'price_distance', 'fill_count',
    'asset_btc', 'asset_eth', 'asset_sol',
    'ret_1h', 'ret_4h', 'ret_15m', 'vol_1h', 'vol_ratio',
    'taker_imbalance',
    'funding_rate',
    'funding_z',
    'vol_z',
    'rvol',
    'var_ratio_2',
    'regime_acf1',
    'cross_ratio_ret',
    'spy_daily_ret',
    'dxy_daily_ret',
    'frac_diff_close',
    'hour_sin',
    'hour_cos',
    'dist_high_96',
    'dist_low_96',
    'ls_ratio_global',
];

// ── Model loading ───────────────────────────────────────────────────────────

export async function loadSignalModels() {
    try {
        _ort = await import('onnxruntime-web');
        const modelsDir = path.join(__dirname, '..', '..', 'models');
        for (const asset of ['btc', 'eth', 'sol']) {
            const modelPath = path.join(modelsDir, `${asset}_signal.onnx`);
            if (fs.existsSync(modelPath)) {
                try {
                    const session = await _ort.InferenceSession.create(modelPath);
                    if (validateModelInputShape(session, asset)) {
                        _signalModels[asset] = session;
                        logger.info(`CMM: signal model loaded for ${asset.toUpperCase()} (${modelPath})`);
                    }
                } catch (err) {
                    logger.warn(`CMM: failed to load ${asset} signal model — ${err.message} (fail-open)`);
                }
            }
        }
    } catch {
        logger.info('CMM: onnxruntime-web not available — signal filter disabled (fail-open)');
    }
}

function validateModelInputShape(session, asset) {
    try {
        const inputName = session?.inputNames?.[0];
        if (!inputName) return false;
        const dims = session.inputMetadata?.[inputName]?.dimensions || [];
        const width = Number.isFinite(dims?.[1]) ? Number(dims[1]) : null;
        const valid = [SIGNAL_FEATURE_COLS.length, SIGNAL_FEATURE_COLS.length + 23];
        if (width !== null && !valid.includes(width)) {
            logger.error(
                `CMM: disabling ${asset.toUpperCase()} model due to feature width mismatch ` +
                `(model=${width}, runtime=${SIGNAL_FEATURE_COLS.length})`
            );
            return false;
        }
        _signalModelWidths[asset] = width ?? SIGNAL_FEATURE_COLS.length;
        return true;
    } catch (err) {
        logger.warn(`CMM: ONNX shape check skipped for ${asset.toUpperCase()} — ${err.message}`);
        return true;
    }
}

// ── ONNX inference ──────────────────────────────────────────────────────────

async function scoreSignal(asset, features) {
    const session = _signalModels[asset.toLowerCase()];
    if (!session || !_ort) return null;

    try {
        const baseRow = SIGNAL_FEATURE_COLS.map(k => features[k] ?? 0);
        const row = baseRow.concat(addEngineeredSignalFeatures(features));
        const tensor = new _ort.Tensor('float32', Float32Array.from(row), [1, row.length]);
        const results = await session.run({ float_input: tensor }, ['label']);
        const label = Number(results['label'].data[0]);
        return label;
    } catch (err) {
        logger.warn(`CMM: signal model inference error — ${err.message} (fail-open)`);
        return null;
    }
}

// ── Feature engineering (23 engineered features) ────────────────────────────

export function addEngineeredSignalFeatures(features) {
    const eps = 1e-8;
    const obi = Number(features.obi ?? 0);
    const cvd = Number(features.cvd_direction ?? 0);
    const conf = Number(features.confidence ?? 0);
    const direction = Number(features.direction ?? 0);
    const priceDistance = Number(features.price_distance ?? 0);
    const ret15 = Number(features.ret_15m ?? 0);
    const ret1h = Number(features.ret_1h ?? 0);
    const ret4h = Number(features.ret_4h ?? 0);
    const vol1h = Number(features.vol_1h ?? 0);
    const volRatio = Number(features.vol_ratio ?? 1);
    const fundingProxy = Number(features.yes_mid ?? 0.5) - 0.5;
    const takerImb = Number(features.taker_imbalance ?? 0);
    const fundingZ = Number(features.funding_z ?? 0);
    const volZ = Number(features.vol_z ?? 0);
    const rvol = Number(features.rvol ?? 1);
    const vr2 = Number(features.var_ratio_2 ?? 1);
    const crossr = Number(features.cross_ratio_ret ?? 0);
    const spy = Number(features.spy_daily_ret ?? 0);
    const dxy = Number(features.dxy_daily_ret ?? 0);
    const fd = Number(features.frac_diff_close ?? 0);
    const hsin = Number(features.hour_sin ?? 0);
    const dh96 = Number(features.dist_high_96 ?? 0);
    const dl96 = Number(features.dist_low_96 ?? 0);
    const ls = Number(features.ls_ratio_global ?? 1);

    return [
        obi * cvd,
        obi * direction,
        conf * direction,
        Math.abs(ret15),
        Math.abs(obi),
        Math.max(0, Math.min(5, volRatio)),
        volRatio > 1.2 ? 1 : 0,
        fundingProxy,
        priceDistance * conf,
        direction * Math.sign(ret1h + eps),
        direction * Math.sign(ret4h + eps),
        Math.abs(ret15) / (vol1h + eps),
        ret15 * cvd,
        conf * Math.abs(obi),
        takerImb * fundingZ,
        volZ * Math.max(0, Math.min(5, rvol)),
        crossr * direction,
        fd * obi,
        hsin * ret15,
        (dh96 + dl96) * 0.5,
        spy * dxy,
        Math.max(-2, Math.min(2, ls - 1)),
        Math.max(0, Math.min(3, vr2)),
    ];
}

// ── Confidence-based sizing ─────────────────────────────────────────────────

export function getConfidenceBands(asset) {
    const a = String(asset || '').toLowerCase();
    const bands = CMM_CONF_BANDS[a] || CMM_CONF_BANDS.default;
    const low = Number.isFinite(bands.low) ? bands.low : 0.55;
    const mid = Number.isFinite(bands.mid) ? bands.mid : 0.56;
    const high = Number.isFinite(bands.high) ? bands.high : 0.58;
    const sorted = [low, mid, high].sort((x, y) => x - y);
    return { low: sorted[0], mid: sorted[1], high: sorted[2] };
}

export function getSizedShares(asset, confidence) {
    const safeConf = Math.max(0, Math.min(1, confidence ?? 0));
    const { low, mid, high } = getConfidenceBands(asset);

    let tier = 'low';
    let baseMult = CMM_SIZE_LOW_MULT;
    if (safeConf >= high) {
        tier = 'high';
        baseMult = CMM_SIZE_HIGH_MULT;
    } else if (safeConf >= mid) {
        tier = 'mid';
        baseMult = CMM_SIZE_MID_MULT;
    }

    const confAdj = 0.90 + 0.20 * safeConf; // [0.90, 1.10]
    const mult = Math.max(0.25, Math.min(3.0, baseMult * confAdj));
    const shares = Math.min(CMM_MAX_SKEW_SHARES, Math.max(5, Math.round(CMM_SHARES * mult)));

    return { shares, mult, tier, safeConf, low, mid, high };
}

// ── Feature building from raw data ──────────────────────────────────────────

/**
 * Build the full ML feature dict from candles, orderFlow, and liveData.
 * Exported for use by backtest harness.
 */
export function buildFeatures(asset, signalCandles, allCandles, orderFlow, liveData, market) {
    const slotDuration = market.slotDuration || SLOT_SEC;
    const yesMid = market.yesMid ?? 0.5;

    const closes = signalCandles.map(c => Number(c.close)).filter(Number.isFinite);
    const highs = signalCandles.map(c => Number(c.high)).filter(Number.isFinite);
    const lows = signalCandles.map(c => Number(c.low)).filter(Number.isFinite);
    const rets = [];
    for (let i = 1; i < closes.length; i++) {
        const prev = closes[i - 1];
        const cur = closes[i];
        rets.push(prev > 0 ? (cur / prev) - 1 : 0);
    }

    const ret15m = rets.length ? rets[rets.length - 1] : 0;
    const ret1h = closes.length >= 5 ? (closes[closes.length - 1] / closes[closes.length - 5] - 1) : 0;
    const ret4h = closes.length >= 17 ? (closes[closes.length - 1] / closes[closes.length - 17] - 1) : 0;
    const vol1h = std(rets.slice(-4));
    const volLong = std(rets.slice(-24));
    const volRatio = volLong > 0 ? vol1h / volLong : 1;
    const var1 = std(rets.slice(-16)) ** 2;
    const twoStep = [];
    for (let i = 1; i < rets.length; i += 2) twoStep.push(rets[i - 1] + rets[i]);
    const var2 = std(twoStep.slice(-8)) ** 2;
    const varRatio2 = var1 > 0 ? var2 / (2 * var1) : 1;
    const regimeAcf1 = corrLag1(rets.slice(-32));

    const highN = highs.length ? Math.max(...highs) : yesMid;
    const lowN = lows.length ? Math.min(...lows) : yesMid;
    const closeNow = closes.length ? closes[closes.length - 1] : 0;
    const distHigh96 = highN > 0 ? closeNow / highN - 1 : 0;
    const distLow96 = lowN > 0 ? closeNow / lowN - 1 : 0;

    const takerImbalance = (orderFlow.buyVol + orderFlow.sellVol) > 0
        ? (orderFlow.buyVol - orderFlow.sellVol) / (orderFlow.buyVol + orderFlow.sellVol)
        : 0;

    // liveData from caller (executor fetches Binance)
    const fr = liveData.fundingRate ?? 0;
    let fundingZ = 0;
    if (liveData.fundingHistory && liveData.fundingHistory.length >= 5) {
        const fMean = liveData.fundingHistory.reduce((a, b) => a + b, 0) / liveData.fundingHistory.length;
        const fStd = std(liveData.fundingHistory);
        fundingZ = fStd > 0 ? (fr - fMean) / fStd : 0;
    }

    // vol_z from full candle buffer
    let volZ = 0;
    if (allCandles.length >= 8) {
        const allCloses = allCandles.map(c => c.close);
        const allRets = [];
        for (let i = 1; i < allCloses.length; i++) {
            allRets.push(allCloses[i - 1] > 0 ? (allCloses[i] / allCloses[i - 1]) - 1 : 0);
        }
        const rollingVols = [];
        for (let i = 3; i < allRets.length; i++) {
            rollingVols.push(std(allRets.slice(i - 3, i + 1)));
        }
        if (rollingVols.length >= 3) {
            const vMean = rollingVols.reduce((a, b) => a + b, 0) / rollingVols.length;
            const vStd = std(rollingVols);
            volZ = vStd > 0 ? (vol1h - vMean) / vStd : 0;
        }
    }

    const rvol = volLong > 0 ? vol1h / volLong : 1;
    const lsRatioGlobal = liveData.lsRatio ?? 1;

    const nowUtc = new Date();
    const h = nowUtc.getUTCHours() + nowUtc.getUTCMinutes() / 60;
    const hourSin = Math.sin(2 * Math.PI * h / 24);
    const hourCos = Math.cos(2 * Math.PI * h / 24);

    // Cross-asset ratio
    const selfPrice = getLastPrice(asset)?.price ?? null;
    const btcPrice = getLastPrice('btc')?.price ?? null;
    const ethPrice = getLastPrice('eth')?.price ?? null;
    let crossRatioRet = 0;
    if (asset.toLowerCase() === 'btc' && selfPrice && ethPrice) {
        crossRatioRet = Math.log(Math.max(1e-12, selfPrice / ethPrice));
    } else if (asset.toLowerCase() === 'eth' && selfPrice && btcPrice) {
        crossRatioRet = Math.log(Math.max(1e-12, selfPrice / btcPrice));
    }

    // frac_diff_close from full candle buffer (reuse allCandles, no duplicate fetch)
    const logCloses = allCandles.map(c => Math.log(Math.max(1e-12, c.close)));
    const fracDiffVal = fracDiffClose(logCloses);

    return {
        obi: orderFlow.obiAvg, cvd_direction: orderFlow.cvd > 0 ? 1 : -1,
        slot_duration: slotDuration, yes_mid: yesMid,
        price_distance: Math.abs(yesMid - 0.5), fill_count: 0,
        asset_btc: asset.toLowerCase() === 'btc' ? 1 : 0,
        asset_eth: asset.toLowerCase() === 'eth' ? 1 : 0,
        asset_sol: asset.toLowerCase() === 'sol' ? 1 : 0,
        ret_1h: ret1h, ret_4h: ret4h, ret_15m: ret15m, vol_1h: vol1h, vol_ratio: volRatio,
        taker_imbalance: takerImbalance,
        funding_rate: fr,
        funding_z: fundingZ,
        vol_z: volZ,
        rvol,
        var_ratio_2: varRatio2,
        regime_acf1: regimeAcf1,
        cross_ratio_ret: crossRatioRet,
        spy_daily_ret: 0,
        dxy_daily_ret: 0,
        frac_diff_close: fracDiffVal,
        hour_sin: hourSin,
        hour_cos: hourCos,
        dist_high_96: distHigh96,
        dist_low_96: distLow96,
        ls_ratio_global: lsRatioGlobal,
    };
}

// ── Main evaluate entry point ───────────────────────────────────────────────

/**
 * Evaluate signal for a given asset.
 *
 * @param {string} asset - 'btc', 'eth', or 'sol'
 * @param {Array} candles - candles since market open (from getCandlesSince)
 * @param {Object} orderFlow - from getOrderFlowSince
 * @param {Object} liveData - { fundingRate, fundingHistory, lsRatio } from Binance
 * @param {Object} market - market object with slotDuration, yesMid, noMid, etc.
 * @returns {Object|null} { direction, side, shares, modelScore, confidence, sizing } or null
 */
export async function evaluate(asset, candles, orderFlow, liveData, market) {
    if (candles.length < CMM_SIGNAL_MINUTES) {
        return null;
    }

    // Run base signal
    const signalFn = ALL_SIGNALS[CMM_SIGNAL_NAME];
    if (!signalFn) {
        logger.warn(`CMM: unknown signal "${CMM_SIGNAL_NAME}"`);
        return null;
    }

    const slotDuration = market.slotDuration || SLOT_SEC;
    const signalCandles = slotDuration > 300 ? candles : candles.slice(0, CMM_SIGNAL_MINUTES);
    const { direction, confidence } = signalFn(signalCandles, { orderFlow });

    if (!direction) return null;

    // Build full feature vector
    const allCandles = getAllCandles(asset);
    const modelFeatures = {
        ...buildFeatures(asset, signalCandles, allCandles, orderFlow, liveData, market),
        confidence,
        direction: direction === 'UP' ? 1 : -1,
    };

    // ML filter (fail-open)
    const modelScore = await scoreSignal(asset, modelFeatures);
    trackModelResult(asset, modelScore);

    if (modelScore !== null && modelScore < CMM_SIGNAL_THRESHOLD) {
        logger.info(`CMM: ${asset.toUpperCase()} — signal=${direction} filtered by model (score=${modelScore.toFixed(3)} < ${CMM_SIGNAL_THRESHOLD})`);
        return null;
    }

    // Confidence-tiered sizing
    const sizing = getSizedShares(asset, confidence);

    return {
        direction,
        side: direction === 'UP' ? 'YES' : 'NO',
        shares: sizing.shares,
        modelScore,
        confidence,
        sizing,
    };
}
