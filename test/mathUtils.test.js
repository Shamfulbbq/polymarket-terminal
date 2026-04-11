/**
 * Math utilities unit tests.
 * Run: node test/mathUtils.test.js
 */

import { std, corrLag1, fracDiffClose } from '../src/utils/mathUtils.js';

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

// ── std ─────────────────────────────────────────────────────────────────────

assert('std(null) = 0', std(null), 0);
assert('std([]) = 0', std([]), 0);
assert('std([5]) = 0', std([5]), 0);
assertClose('std([2, 4]) = sqrt(2)', std([2, 4]), Math.sqrt(2));

// Known dataset: [2, 4, 4, 4, 5, 5, 7, 9] — sample std = 2.138...
const knownArr = [2, 4, 4, 4, 5, 5, 7, 9];
const knownMean = 5;
const knownVarSum = (2-5)**2 + (4-5)**2 + (4-5)**2 + (4-5)**2 + (5-5)**2 + (5-5)**2 + (7-5)**2 + (9-5)**2;
const expectedStd = Math.sqrt(knownVarSum / 7); // Bessel: n-1 = 7
assertClose('std([2,4,4,4,5,5,7,9])', std(knownArr), expectedStd);

// Constant array — std should be 0
assertClose('std of constant array', std([3, 3, 3, 3]), 0);

// ── corrLag1 ────────────────────────────────────────────────────────────────

assert('corrLag1(null) = 0', corrLag1(null), 0);
assert('corrLag1([]) = 0', corrLag1([]), 0);
assert('corrLag1([1, 2]) = 0', corrLag1([1, 2]), 0); // < 3 elements

// Perfect positive correlation: monotonic increasing
// [1,2,3,4,5] → x=[2,3,4,5], y=[1,2,3,4] → r=1.0
assertClose('corrLag1 perfect positive', corrLag1([1, 2, 3, 4, 5]), 1.0, 1e-10);

// Perfect negative correlation: alternating [1, -1, 1, -1, 1]
// x=[-1,1,-1,1], y=[1,-1,1,-1] → r=-1.0
assertClose('corrLag1 perfect negative', corrLag1([1, -1, 1, -1, 1]), -1.0, 1e-10);

// Constant array: r = 0 (denominator zero)
assert('corrLag1 constant', corrLag1([5, 5, 5, 5]), 0);

// ── fracDiffClose ───────────────────────────────────────────────────────────

// Too few data points
assertClose('fracDiffClose empty', fracDiffClose([]), 0.0);
assertClose('fracDiffClose short', fracDiffClose([1, 2, 3]), 0.0);

// Known properties: weights computation with d=0.35, th=1e-4
// First weight is always 1.0, second is -d = -0.35
// Need at least w.length data points. Let's generate enough.
const longSeries = Array.from({ length: 300 }, (_, i) => Math.log(100 + i * 0.01));
const result = fracDiffClose(longSeries);
assert('fracDiffClose returns finite', Number.isFinite(result), true);
assert('fracDiffClose non-zero for long series', result !== 0, true);

// Constant series: FFD(constant) = constant * sum(weights), which is non-zero
// for fractional d. Verify it returns a finite, deterministic value.
const constantSeries = Array.from({ length: 300 }, () => Math.log(100));
const constResult = fracDiffClose(constantSeries);
assert('fracDiffClose constant returns finite', Number.isFinite(constResult), true);

// Deterministic: same input → same output
const result2 = fracDiffClose(longSeries);
assertClose('fracDiffClose deterministic', result, result2, 0);

// ── Results ─────────────────────────────────────────────────────────────────
console.log(`\nMath utils tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
