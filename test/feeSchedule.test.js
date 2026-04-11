/**
 * Fee schedule unit tests.
 * Run: node test/feeSchedule.test.js
 */

import { computeFee, getRebateRate, getSchedule, checkStaleness } from '../src/services/feeSchedule.js';

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

function assertClose(label, actual, expected, tolerance = 0.0001) {
    if (Math.abs(actual - expected) <= tolerance) {
        passed++;
    } else {
        failed++;
        console.error(`FAIL: ${label} — expected ~${expected}, got ${actual} (tolerance ${tolerance})`);
    }
}

function assertRange(label, actual, min, max) {
    if (actual >= min && actual <= max) {
        passed++;
    } else {
        failed++;
        console.error(`FAIL: ${label} — expected ${min}-${max}, got ${actual}`);
    }
}

// ── Schedule loading ─────────────────────────────────────────────────────────

const schedule = getSchedule();
assert('schedule loaded', schedule !== null && schedule !== undefined, true);
assert('crypto category exists', 'crypto' in schedule, true);
assert('weather category exists', 'weather' in schedule, true);
assert('geopolitics category exists', 'geopolitics' in schedule, true);

// ── computeFee: crypto at p=0.50 (peak) ─────────────────────────────────────
// fee = 1 * 0.288 * (0.50 * 0.50)^2 = 0.288 * 0.0625 = 0.018
assertClose('crypto fee at p=0.50 (1 share)', computeFee(1, 0.50, 'crypto'), 0.018);

// 20 shares at p=0.50: fee = 20 * 0.018 = 0.36
assertClose('crypto fee at p=0.50 (20 shares)', computeFee(20, 0.50, 'crypto'), 0.36);

// ── computeFee: crypto at p=0.30 ────────────────────────────────────────────
// fee = 1 * 0.288 * (0.30 * 0.70)^2 = 0.288 * 0.0441 = 0.0127008
assertClose('crypto fee at p=0.30', computeFee(1, 0.30, 'crypto'), 0.0127008);

// ── computeFee: weather at p=0.50 (peak) ────────────────────────────────────
// fee = 1 * 0.16 * (0.50 * 0.50)^2 = 0.16 * 0.0625 = 0.01
assertClose('weather fee at p=0.50', computeFee(1, 0.50, 'weather'), 0.01);

// ── computeFee: weather at p=0.30 ───────────────────────────────────────────
// fee = 1 * 0.16 * (0.30 * 0.70)^2 = 0.16 * 0.0441 = 0.007056
assertClose('weather fee at p=0.30', computeFee(1, 0.30, 'weather'), 0.007056);

// ── computeFee: geopolitics (always 0) ──────────────────────────────────────
assertClose('geopolitics fee at p=0.50', computeFee(1, 0.50, 'geopolitics'), 0);
assertClose('geopolitics fee at p=0.30', computeFee(100, 0.30, 'geopolitics'), 0);

// ── computeFee: boundary prices ─────────────────────────────────────────────
assertClose('fee at p=0 is 0', computeFee(1, 0, 'crypto'), 0);
assertClose('fee at p=1 is 0', computeFee(1, 1, 'crypto'), 0);
assertClose('fee at p=0.99 near-zero', computeFee(1, 0.99, 'crypto'), 0.288 * Math.pow(0.99 * 0.01, 2));

// ── computeFee: 0 shares ────────────────────────────────────────────────────
assertClose('fee with 0 shares is 0', computeFee(0, 0.50, 'crypto'), 0);

// ── computeFee: unknown category falls back to crypto ───────────────────────
const unknownFee = computeFee(1, 0.50, 'nonexistent_category');
const cryptoFee = computeFee(1, 0.50, 'crypto');
assertClose('unknown category falls back to crypto', unknownFee, cryptoFee);

// ── computeFee: sports uses different exponent ──────────────────────────────
// fee = 1 * 0.03 * (0.50 * 0.50)^0.5 = 0.03 * sqrt(0.25) = 0.03 * 0.5 = 0.015
assertClose('sports fee at p=0.50 (exponent=0.5)', computeFee(1, 0.50, 'sports'), 0.015);

// ── getRebateRate ────────────────────────────────────────────────────────────
assertClose('crypto rebate rate', getRebateRate('crypto'), 0.20);
assertClose('sports rebate rate', getRebateRate('sports'), 0.25);
assertClose('geopolitics rebate rate', getRebateRate('geopolitics'), 0.00);

// ── getRebateRate: unknown category falls back to crypto ────────────────────
assertClose('unknown category rebate falls back', getRebateRate('nonexistent'), 0.20);

// ── Consistency: crypto fee matches formula with current C=0.288 ────────────
// Formula: shares * C * Math.pow(price * (1 - price), exponent)
function expectedCryptoFee(shares, price) {
    return shares * 0.288 * Math.pow(price * (1 - price), 2);
}

const testPrices = [0.10, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90];
for (const p of testPrices) {
    const expected = expectedCryptoFee(20, p);
    const actual = computeFee(20, p, 'crypto');
    assertClose(`formula consistency at p=${p}`, actual, expected, 0.00001);
}

// ── checkStaleness: should not crash ────────────────────────────────────────
const staleResult = checkStaleness();
assert('checkStaleness returns boolean', typeof staleResult, 'boolean');

// ── Results ──────────────────────────────────────────────────────────────────
console.log(`\nFee schedule tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
