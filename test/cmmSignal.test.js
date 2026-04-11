/**
 * CMM signal module unit tests.
 * Run: node test/cmmSignal.test.js
 *
 * Tests pure functions only (no ONNX, no network).
 */

import { addEngineeredSignalFeatures, getConfidenceBands, getSizedShares, checkModelDegradation, getModelStats } from '../src/services/cmmSignal.js';

let passed = 0;
let failed = 0;

function assert(label, actual, expected) {
    if (actual === expected) {
        passed++;
    } else {
        failed++;
        console.error(`FAIL: ${label} — expected ${expected}, got ${actual}`);
    }
}

function assertClose(label, actual, expected, tolerance = 1e-6) {
    if (Math.abs(actual - expected) <= tolerance) {
        passed++;
    } else {
        failed++;
        console.error(`FAIL: ${label} — expected ~${expected}, got ${actual} (tolerance ${tolerance})`);
    }
}

// ── addEngineeredSignalFeatures ─────────────────────────────────────────────

// Empty/default features — should return 23 elements, all derived from defaults
const emptyResult = addEngineeredSignalFeatures({});
assert('engineered features returns 23 elements', emptyResult.length, 23);
assert('all engineered features are finite', emptyResult.every(Number.isFinite), true);

// With known inputs, verify specific cross-features
const knownFeatures = {
    obi: 0.5, cvd_direction: 1, confidence: 0.8, direction: 1,
    price_distance: 0.1, ret_15m: 0.02, ret_1h: 0.05, ret_4h: 0.10,
    vol_1h: 0.03, vol_ratio: 1.5, yes_mid: 0.55, taker_imbalance: 0.3,
    funding_z: 0.5, vol_z: 1.0, rvol: 1.2, var_ratio_2: 1.1,
    cross_ratio_ret: 0.01, spy_daily_ret: 0.005, dxy_daily_ret: -0.002,
    frac_diff_close: 0.1, hour_sin: 0.5, dist_high_96: -0.02, dist_low_96: 0.03,
    ls_ratio_global: 1.1,
};
const knownResult = addEngineeredSignalFeatures(knownFeatures);
assert('known features returns 23 elements', knownResult.length, 23);

// Feature 0: obi * cvd = 0.5 * 1 = 0.5
assertClose('obi * cvd', knownResult[0], 0.5);
// Feature 1: obi * direction = 0.5 * 1 = 0.5
assertClose('obi * direction', knownResult[1], 0.5);
// Feature 2: conf * direction = 0.8 * 1 = 0.8
assertClose('conf * direction', knownResult[2], 0.8);
// Feature 3: abs(ret_15m) = 0.02
assertClose('abs ret_15m', knownResult[3], 0.02);
// Feature 4: abs(obi) = 0.5
assertClose('abs obi', knownResult[4], 0.5);
// Feature 5: clamp(vol_ratio, 0, 5) = 1.5
assertClose('vol_ratio clamped', knownResult[5], 1.5);
// Feature 6: vol_ratio > 1.2 ? 1 : 0 = 1
assertClose('vol_ratio flag', knownResult[6], 1);

// Deterministic
const knownResult2 = addEngineeredSignalFeatures(knownFeatures);
for (let i = 0; i < 23; i++) {
    assertClose(`deterministic feature ${i}`, knownResult[i], knownResult2[i], 0);
}

// ── getConfidenceBands ──────────────────────────────────────────────────────

const btcBands = getConfidenceBands('btc');
assertClose('btc low band', btcBands.low, 0.55);
assertClose('btc mid band', btcBands.mid, 0.56);
assertClose('btc high band', btcBands.high, 0.58);

const ethBands = getConfidenceBands('eth');
assertClose('eth low band', ethBands.low, 0.54);
assertClose('eth mid band', ethBands.mid, 0.55);
assertClose('eth high band', ethBands.high, 0.57);

// Unknown asset → default bands
const unkBands = getConfidenceBands('doge');
assertClose('unknown low band = default', unkBands.low, 0.55);

// Case insensitive
const btcUpper = getConfidenceBands('BTC');
assertClose('case insensitive', btcUpper.low, btcBands.low);

// Bands are sorted
assert('bands sorted low <= mid', btcBands.low <= btcBands.mid, true);
assert('bands sorted mid <= high', btcBands.mid <= btcBands.high, true);

// ── getSizedShares ──────────────────────────────────────────────────────────

// High confidence → high tier
const highConf = getSizedShares('btc', 0.60);
assert('high conf tier', highConf.tier, 'high');
assert('high conf shares >= 5', highConf.shares >= 5, true);
assert('high conf shares finite', Number.isFinite(highConf.shares), true);

// Mid confidence
const midConf = getSizedShares('btc', 0.57);
assert('mid conf tier', midConf.tier, 'mid');

// Low confidence
const lowConf = getSizedShares('btc', 0.54);
assert('low conf tier', lowConf.tier, 'low');

// High tier produces more shares than low tier
assert('high > low shares', highConf.shares >= lowConf.shares, true);

// Zero confidence → low tier, minimum 5 shares
const zeroConf = getSizedShares('btc', 0);
assert('zero conf tier', zeroConf.tier, 'low');
assert('zero conf min 5 shares', zeroConf.shares >= 5, true);

// Confidence clamped to [0, 1]
const overConf = getSizedShares('btc', 1.5);
assertClose('conf clamped to 1', overConf.safeConf, 1.0);
const negConf = getSizedShares('btc', -0.5);
assertClose('conf clamped to 0', negConf.safeConf, 0.0);

// Returns all expected fields
assert('sizing has shares', 'shares' in highConf, true);
assert('sizing has mult', 'mult' in highConf, true);
assert('sizing has tier', 'tier' in highConf, true);
assert('sizing has safeConf', 'safeConf' in highConf, true);
assert('sizing has low', 'low' in highConf, true);
assert('sizing has mid', 'mid' in highConf, true);
assert('sizing has high', 'high' in highConf, true);

// ── checkModelDegradation ───────────────────────────────────────────────────

// Fresh state — no degradation
const freshCheck = checkModelDegradation('test_asset');
assert('fresh state not degraded', freshCheck.degraded, false);

// ── Results ─────────────────────────────────────────────────────────────────
console.log(`\nCMM signal tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
