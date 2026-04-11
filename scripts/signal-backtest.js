#!/usr/bin/env node
/**
 * signal-backtest.js
 * Replay historical crypto_mm.jsonl data and evaluate signal quality.
 *
 * For each signal entry that has a matching outcome:
 *   - Was the direction correct?
 *   - What was the model score?
 *   - What was the PnL?
 *
 * Aggregates: win rate, signal fire rate, expected value.
 *
 * Usage:
 *   node scripts/signal-backtest.js                           # all data
 *   node scripts/signal-backtest.js --file data/crypto_mm.jsonl
 *   node scripts/signal-backtest.js --asset btc               # filter by asset
 *   node scripts/signal-backtest.js --since 2026-04-05        # filter by date
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Parse args ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(flag) {
    const idx = args.indexOf(flag);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
}

const logFile = getArg('--file') || path.join(__dirname, '..', 'data', 'crypto_mm.jsonl');
const filterAsset = getArg('--asset')?.toLowerCase() || null;
const sinceDate = getArg('--since') || null;

if (!fs.existsSync(logFile)) {
    console.error(`File not found: ${logFile}`);
    process.exit(1);
}

// ── Read and parse ──────────────────────────────────────────────────────────

const lines = fs.readFileSync(logFile, 'utf-8').split('\n').filter(Boolean);
const rows = [];
for (const line of lines) {
    try { rows.push(JSON.parse(line)); } catch { /* skip malformed */ }
}

console.log(`Loaded ${rows.length} rows from ${path.basename(logFile)}`);

// ── Index entries and outcomes by conditionId ───────────────────────────────

const signalEntries = new Map(); // conditionId -> entry row
const signalFiltered = new Map(); // conditionId -> filtered row
const outcomes = new Map();       // conditionId -> outcome row

for (const row of rows) {
    const cid = row.conditionId;
    if (!cid) continue;

    // Date filter
    if (sinceDate && row.ts < sinceDate) continue;
    // Asset filter
    if (filterAsset && row.asset?.toLowerCase() !== filterAsset) continue;

    if (row.action === 'signal_skew' || row.action === 'signal_entry') {
        signalEntries.set(cid, row);
    } else if (row.action === 'signal_filtered') {
        signalFiltered.set(cid, row);
    } else if (row.action === 'outcome') {
        outcomes.set(cid, row);
    }
}

console.log(`Signal entries: ${signalEntries.size} | Filtered: ${signalFiltered.size} | Outcomes: ${outcomes.size}`);
console.log('');

// ── Replay: match entries to outcomes ───────────────────────────────────────

let wins = 0, losses = 0, totalPnl = 0;
const perAsset = {};
const perTier = { low: { w: 0, l: 0 }, mid: { w: 0, l: 0 }, high: { w: 0, l: 0 }, unknown: { w: 0, l: 0 } };

for (const [cid, entry] of signalEntries) {
    const outcome = outcomes.get(cid);
    if (!outcome) continue; // no resolution — skip

    const directionCorrect = (entry.direction === 'UP' && outcome.outcome === 'UP') ||
                             (entry.direction === 'DOWN' && outcome.outcome === 'DOWN');

    const asset = (entry.asset || '').toUpperCase();
    const pnl = outcome.marketPnl ?? 0;

    if (directionCorrect) wins++;
    else losses++;
    totalPnl += pnl;

    // Per-asset tracking
    if (!perAsset[asset]) perAsset[asset] = { wins: 0, losses: 0, pnl: 0, count: 0 };
    perAsset[asset].count++;
    perAsset[asset].pnl += pnl;
    if (directionCorrect) perAsset[asset].wins++;
    else perAsset[asset].losses++;

    // Per-tier tracking
    const tier = entry.sizeTier || 'unknown';
    if (perTier[tier]) {
        if (directionCorrect) perTier[tier].w++;
        else perTier[tier].l++;
    }
}

// ── Signal fire rate ────────────────────────────────────────────────────────

// Total signals that could have fired = entries + filtered
const totalSignals = signalEntries.size + signalFiltered.size;
const fireRate = totalSignals > 0 ? (signalEntries.size / totalSignals * 100).toFixed(1) : 'N/A';

// ── Print results ───────────────────────────────────────────────────────────

const total = wins + losses;
const winRate = total > 0 ? (wins / total * 100).toFixed(1) : 'N/A';
const avgPnl = total > 0 ? (totalPnl / total).toFixed(2) : 'N/A';

console.log('═══════════════════════════════════════════════════');
console.log('  SIGNAL BACKTEST RESULTS');
console.log('═══════════════════════════════════════════════════');
console.log(`  Total resolved:  ${total} (${wins}W / ${losses}L)`);
console.log(`  Win rate:        ${winRate}%`);
console.log(`  Signal fire rate: ${fireRate}% (${signalEntries.size}/${totalSignals})`);
console.log(`  Total PnL:       $${totalPnl.toFixed(2)}`);
console.log(`  Avg PnL/trade:   $${avgPnl}`);
console.log('');

// Per-asset breakdown
console.log('  Per-asset:');
for (const [asset, data] of Object.entries(perAsset).sort()) {
    const wr = data.count > 0 ? (data.wins / data.count * 100).toFixed(1) : 'N/A';
    const avg = data.count > 0 ? (data.pnl / data.count).toFixed(2) : 'N/A';
    console.log(`    ${asset.padEnd(5)} ${data.count} trades | ${wr}% win | $${data.pnl.toFixed(2)} total | $${avg}/trade`);
}
console.log('');

// Per-tier breakdown
console.log('  Per-tier:');
for (const [tier, data] of Object.entries(perTier)) {
    const t = data.w + data.l;
    if (t === 0) continue;
    const wr = (data.w / t * 100).toFixed(1);
    console.log(`    ${tier.padEnd(8)} ${t} trades | ${wr}% win`);
}
console.log('═══════════════════════════════════════════════════');
