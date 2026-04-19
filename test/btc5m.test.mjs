/**
 * btc5m unit tests — pure functions only, no I/O.
 * Run: node test/btc5m.test.mjs
 */

// ── Test harness ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, label) {
    if (condition) {
        console.log(`  ✓ ${label}`);
        passed++;
    } else {
        console.error(`  ✗ ${label}`);
        failed++;
    }
}

function assertEq(a, b, label) {
    assert(a === b, `${label} — expected ${b}, got ${a}`);
}

function group(name, fn) {
    console.log(`\n${name}`);
    fn();
}

// ── Inline pure functions (copied from bot.mjs/signal.mjs, no imports needed) ─

// computeGridRungs
const GRID_MIN = 0.04, GRID_MAX = 0.99, GRID_STEP = 0.01, MAX_RUNGS = 90, UNIT_SHARES = 5;
function computeGridRungs(side, bestAsk, tickSize) {
    const rungs = [];
    let level = GRID_MAX;
    while (rungs.length < MAX_RUNGS && level >= GRID_MIN - 1e-9) {
        const px = Math.round(level / tickSize) * tickSize;
        if (px < bestAsk - 1e-9) {
            rungs.push({ price: +px.toFixed(3), shares: UNIT_SHARES, side });
        }
        level = Math.round((level - GRID_STEP) * 1000) / 1000;
    }
    return rungs;
}

// simulateFillsFallback
function simulateFillsFallback(rungs, openAsk, thisSideWon) {
    return thisSideWon ? rungs.filter(r => r.price >= openAsk - 0.05) : rungs;
}

// recommendMode
function recommendMode({ flow3s, flow30s, bias3s, bias30s, trades30s }) {
    if (trades30s == null || trades30s < 20) return { mode: 'BALANCED', reason: 'low_volume' };
    const STRONG = 0.40, MILD = 0.20;
    if (bias30s <= -STRONG && bias3s <= -STRONG) return { mode: 'STRONG_DN', reason: 'strong_dn' };
    if (bias30s >=  STRONG && bias3s >=  STRONG) return { mode: 'STRONG_UP', reason: 'strong_up' };
    if (bias30s <= -MILD   && bias3s <= -MILD)   return { mode: 'LEAN_DN',   reason: 'mild_dn' };
    if (bias30s >=  MILD   && bias3s >=  MILD)   return { mode: 'LEAN_UP',   reason: 'mild_up' };
    return { mode: 'BALANCED', reason: 'no_clear_trend' };
}

// ── Tests ────────────────────────────────────────────────────────────────────

group('computeGridRungs', () => {
    const rungs = computeGridRungs('UP', 0.55, 0.01);

    assert(rungs.length > 0, 'produces rungs when ask > GRID_MIN');
    assert(rungs.every(r => r.price < 0.55), 'all prices below bestAsk');
    assert(rungs.every(r => r.price >= GRID_MIN), 'all prices >= GRID_MIN');
    assert(rungs.every(r => r.price <= GRID_MAX), 'all prices <= GRID_MAX');
    assert(rungs.every(r => r.shares === UNIT_SHARES), 'all rungs have UNIT_SHARES');
    assert(rungs.every(r => r.side === 'UP'), 'all rungs labelled UP');

    // Prices should be descending (GRID_MAX down to first below bestAsk)
    for (let i = 1; i < rungs.length; i++) {
        assert(rungs[i].price < rungs[i - 1].price, `rung[${i}] price descending`);
    }

    // bestAsk at 0.01 (minimum) — no rungs possible
    const noRungs = computeGridRungs('UP', 0.01, 0.01);
    assertEq(noRungs.length, 0, 'no rungs when bestAsk <= GRID_MIN');

    // bestAsk at 1.00 — all rungs from GRID_MAX to GRID_MIN
    const allRungs = computeGridRungs('DN', 1.00, 0.01);
    assert(allRungs.length > 0, 'rungs when bestAsk = 1.00');
    assert(allRungs.every(r => r.side === 'DN'), 'DN label correct');

    // Capped at MAX_RUNGS
    const capped = computeGridRungs('UP', 99.00, 0.01);
    assert(capped.length <= MAX_RUNGS, 'never exceeds MAX_RUNGS');

    // Rung prices are rounded to tickSize
    const r01 = computeGridRungs('UP', 0.80, 0.01);
    assert(r01.every(r => Math.abs(r.price * 100 - Math.round(r.price * 100)) < 1e-9),
        'prices rounded to 0.01 tickSize');
});

group('simulateFillsFallback', () => {
    const rungs = [
        { price: 0.50, shares: 5 },
        { price: 0.48, shares: 5 },
        { price: 0.45, shares: 5 },
        { price: 0.40, shares: 5 },
        { price: 0.30, shares: 5 },
    ];

    // Winning side: fills rungs within 0.05 of openAsk
    const winFills = simulateFillsFallback(rungs, 0.50, true);
    assert(winFills.every(r => r.price >= 0.50 - 0.05), 'winning fills within 0.05 of openAsk');
    assert(winFills.length < rungs.length, 'winning side fills fewer rungs than all');

    // Losing side: fills everything
    const loseFills = simulateFillsFallback(rungs, 0.50, false);
    assertEq(loseFills.length, rungs.length, 'losing side fills all rungs');

    // Empty rungs — no crash
    const emptyWin = simulateFillsFallback([], 0.50, true);
    assertEq(emptyWin.length, 0, 'empty rungs → empty fills (win)');
    const emptyLose = simulateFillsFallback([], 0.50, false);
    assertEq(emptyLose.length, 0, 'empty rungs → empty fills (lose)');

    // All rungs far from openAsk — winning side gets nothing
    const farRungs = [{ price: 0.10, shares: 5 }, { price: 0.08, shares: 5 }];
    const farWin = simulateFillsFallback(farRungs, 0.50, true);
    assertEq(farWin.length, 0, 'winning side: no fills when all rungs far from ask');
});

group('recommendMode', () => {
    const base = { flow3s: 0.5, flow30s: 0.5 };

    // Low volume → balanced regardless of bias
    assertEq(recommendMode({ ...base, bias3s: 0.9, bias30s: 0.9, trades30s: 5 }).mode, 'BALANCED', 'low trades → BALANCED');
    assertEq(recommendMode({ ...base, bias3s: -0.9, bias30s: -0.9, trades30s: null }).mode, 'BALANCED', 'null trades → BALANCED');

    // Strong UP (both bias30s and bias3s >= 0.40)
    assertEq(recommendMode({ ...base, bias3s: 0.45, bias30s: 0.50, trades30s: 50 }).mode, 'STRONG_UP', 'STRONG_UP when both biases >= 0.40');

    // Strong DN
    assertEq(recommendMode({ ...base, bias3s: -0.45, bias30s: -0.50, trades30s: 50 }).mode, 'STRONG_DN', 'STRONG_DN when both biases <= -0.40');

    // Lean UP
    assertEq(recommendMode({ ...base, bias3s: 0.25, bias30s: 0.30, trades30s: 50 }).mode, 'LEAN_UP', 'LEAN_UP when both biases in [0.20, 0.40)');

    // Lean DN
    assertEq(recommendMode({ ...base, bias3s: -0.25, bias30s: -0.30, trades30s: 50 }).mode, 'LEAN_DN', 'LEAN_DN when both biases in (-0.40, -0.20]');

    // Mixed signal — one strong, one weak → BALANCED
    assertEq(recommendMode({ ...base, bias3s: 0.50, bias30s: 0.05, trades30s: 50 }).mode, 'BALANCED', 'mixed bias → BALANCED');

    // Near threshold
    assertEq(recommendMode({ ...base, bias3s: 0.19, bias30s: 0.19, trades30s: 50 }).mode, 'BALANCED', 'just below MILD threshold → BALANCED');
    assertEq(recommendMode({ ...base, bias3s: 0.20, bias30s: 0.20, trades30s: 50 }).mode, 'LEAN_UP', 'at MILD threshold → LEAN_UP');
    assertEq(recommendMode({ ...base, bias3s: 0.40, bias30s: 0.40, trades30s: 50 }).mode, 'STRONG_UP', 'at STRONG threshold → STRONG_UP');
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
