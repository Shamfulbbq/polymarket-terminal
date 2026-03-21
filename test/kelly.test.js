/**
 * Kelly sizing unit tests.
 * Run: node test/kelly.test.js
 */

import { kellyShares } from '../src/utils/kelly.js';

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

function assertRange(label, actual, min, max) {
    if (actual >= min && actual <= max) {
        passed++;
    } else {
        failed++;
        console.error(`FAIL: ${label} — expected ${min}-${max}, got ${actual}`);
    }
}

// ── Not enough data → return minShares ──────────────────────────────────────
assert('too few trades → minShares',
    kellyShares({ winRate: 0.98, entryPrice: 0.95, balance: 100, totalTrades: 10, minTrades: 30 }),
    1,
);

// ── Edge cases: invalid inputs → safe defaults ──────────────────────────────
assert('winRate=0 → minShares',
    kellyShares({ winRate: 0, entryPrice: 0.95, balance: 100, totalTrades: 50, minTrades: 30 }),
    1,
);

assert('winRate=1 → minShares (guard against infinity)',
    kellyShares({ winRate: 1, entryPrice: 0.95, balance: 100, totalTrades: 50, minTrades: 30 }),
    1,
);

assert('winRate=NaN → minShares',
    kellyShares({ winRate: NaN, entryPrice: 0.95, balance: 100, totalTrades: 50, minTrades: 30 }),
    1,
);

assert('entryPrice=0 → minShares',
    kellyShares({ winRate: 0.95, entryPrice: 0, balance: 100, totalTrades: 50, minTrades: 30 }),
    1,
);

assert('balance=0 → 0',
    kellyShares({ winRate: 0.95, entryPrice: 0.95, balance: 0, totalTrades: 50, minTrades: 30 }),
    0,
);

// ── No edge (win rate too low for entry price) → 0 ─────────────────────────
assert('no edge (50% wr at 95c) → 0',
    kellyShares({ winRate: 0.50, entryPrice: 0.95, balance: 100, totalTrades: 50, minTrades: 30 }),
    0,
);

// ── Positive edge → reasonable shares ───────────────────────────────────────
// 98% win rate at 0.95 entry → strong edge
const strongEdge = kellyShares({
    winRate: 0.98, entryPrice: 0.95, balance: 100,
    totalTrades: 100, minTrades: 30, maxShares: 20,
});
assertRange('strong edge (98% at 0.95) → 5-20 shares', strongEdge, 5, 20);

// 92% win rate at 0.90 entry → moderate edge
const modEdge = kellyShares({
    winRate: 0.92, entryPrice: 0.90, balance: 50,
    totalTrades: 50, minTrades: 30, maxShares: 20,
});
assertRange('moderate edge (92% at 0.90) → 1-15 shares', modEdge, 1, 15);

// ── Hard cap respected ──────────────────────────────────────────────────────
const capped = kellyShares({
    winRate: 0.99, entryPrice: 0.90, balance: 10000,
    totalTrades: 200, minTrades: 30, maxShares: 20,
});
assert('hard cap at maxShares=20', capped, 20);

// ── Results ─────────────────────────────────────────────────────────────────
console.log(`\nKelly tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
