/**
 * parity_check.mjs
 * Verifies JS feature builder (used by bot.mjs / recorder.mjs) produces
 * numerically identical output to Python build_dataset.py on the same candles.
 *
 * Method:
 *   1. Python side writes a small sample: data/btc5m/parity_sample.json
 *      (first 200 candles of klines_1m.parquet + the computed feature matrix)
 *   2. This script re-computes features in JS from those candles and diffs.
 *
 * Fail if any feature mean-abs-diff > 1e-5.
 *
 * Usage:  node src/btc5m/parity_check.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..', '..');
const SAMPLE    = path.join(ROOT, 'data', 'btc5m', 'parity_sample.json');

const FEATURE_NAMES = [
    'ret', 'log_vol', 'taker_ratio', 'hl_range', 'body_ratio',
    'ret_5', 'ret_15', 'ret_30', 'vol_ratio',
    'hour_sin', 'hour_cos', 'dow_sin', 'dow_cos',
];

// ── Feature builder (COPY of bot.mjs::buildFeatureSeq internals, no slicing) ──
function buildFeatures(candles) {
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

    return candles.map((c, i) => {
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
}

if (!fs.existsSync(SAMPLE)) {
    console.error(`Missing ${SAMPLE}. Run: src/btc5m/.venv/Scripts/python.exe src/btc5m/parity_dump.py`);
    process.exit(1);
}

const data = JSON.parse(fs.readFileSync(SAMPLE, 'utf-8'));
const candles = data.candles;  // array of {openTime, open, high, low, close, volume, takerBuyBaseVol}
const pyFeats = data.features; // array of 13-element rows

// openTime in JS needs to be the ms-scale that Python uses. Python uses microseconds
// in bulk CSV files; the `openTime` we pass is the raw int. Since our hour/dow code
// does `Math.floor(c.openTime / 1000)`, it expects millisecond epochs.
// Python uses `ts_sec = openTime // 1_000_000`. So we must convert: pass openTime as ms.
// The parity_dump.py writes openTime / 1000 so JS sees ms.
const jsFeats = buildFeatures(candles);

if (jsFeats.length !== pyFeats.length) {
    console.error(`length mismatch: js=${jsFeats.length} py=${pyFeats.length}`);
    process.exit(1);
}

const nFeat = 13;
const diffs = new Array(nFeat).fill(0);
const maxDiff = new Array(nFeat).fill(0);
let count = 0;

// Skip first 30 rows — rolling windows aren't at steady state
const SKIP = 30;
for (let i = SKIP; i < jsFeats.length; i++) {
    for (let f = 0; f < nFeat; f++) {
        const d = Math.abs(jsFeats[i][f] - pyFeats[i][f]);
        diffs[f] += d;
        if (d > maxDiff[f]) maxDiff[f] = d;
    }
    count++;
}

let worstFeat = null, worstMeanDiff = 0;
console.log(`\nParity check on ${count} rows (skipping first ${SKIP}):`);
console.log(`${'Feature'.padEnd(14)} ${'mean_abs_diff'.padEnd(16)} ${'max_abs_diff'}`);
console.log('─'.repeat(55));
for (let f = 0; f < nFeat; f++) {
    const meanDiff = diffs[f] / count;
    const ok = meanDiff < 1e-5 ? 'OK' : 'FAIL';
    console.log(`${FEATURE_NAMES[f].padEnd(14)} ${meanDiff.toExponential(3).padEnd(16)} ${maxDiff[f].toExponential(3)}  ${ok}`);
    if (meanDiff > worstMeanDiff) { worstMeanDiff = meanDiff; worstFeat = FEATURE_NAMES[f]; }
}

if (worstMeanDiff < 1e-5) {
    console.log(`\nPARITY OK — worst feature ${worstFeat} mean_diff=${worstMeanDiff.toExponential(3)}`);
    process.exit(0);
} else {
    console.log(`\nPARITY FAIL — ${worstFeat} mean_diff=${worstMeanDiff.toExponential(3)} > threshold 1e-5`);
    process.exit(1);
}
