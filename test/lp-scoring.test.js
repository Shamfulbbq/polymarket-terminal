/**
 * LP liquidity scoring unit tests.
 * Run: node test/lp-scoring.test.js
 */

import { liquidityScore } from '../src/services/rewardScanner.js';

let passed = 0;
let failed = 0;

function assert(label, actual, expected) {
    if (actual === expected) { passed++; }
    else { failed++; console.error(`FAIL: ${label} — expected ${expected}, got ${actual}`); }
}

function assertGt(label, a, b) {
    if (a > b) { passed++; }
    else { failed++; console.error(`FAIL: ${label} — expected ${a} > ${b}`); }
}

// ── Tight spread + high volume = high score ─────────────────────────────────
const liquid = liquidityScore(0.02, 100000);
const illiquid = liquidityScore(0.20, 1000);
assertGt('liquid market scores higher than illiquid', liquid, illiquid);

// ── Zero volume = zero score ────────────────────────────────────────────────
const zeroVol = liquidityScore(0.02, 0);
assert('zero volume = zero score', zeroVol, 0);

// ── Edge cases ──────────────────────────────────────────────────────────────
const negSpread = liquidityScore(-0.05, 50000);
assertGt('negative spread (invalid) still returns positive', negSpread, 0);

const nanSpread = liquidityScore(NaN, 50000);
assertGt('NaN spread handled gracefully', nanSpread, 0);

const nanVol = liquidityScore(0.02, NaN);
assert('NaN volume handled gracefully', nanVol, 0);

// ── Spread dominates: same volume, different spreads ────────────────────────
const tight = liquidityScore(0.01, 50000);
const wide = liquidityScore(0.10, 50000);
assertGt('tighter spread scores higher at same volume', tight, wide);

// ── Volume matters: same spread, different volumes ──────────────────────────
const highVol = liquidityScore(0.03, 500000);
const lowVol = liquidityScore(0.03, 5000);
assertGt('higher volume scores higher at same spread', highVol, lowVol);

console.log(`\nLP scoring tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
