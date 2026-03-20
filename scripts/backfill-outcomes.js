/**
 * backfill-outcomes.js
 *
 * Fetches resolution outcomes for all directional trades in
 * data/directional_orders.jsonl and writes enriched records to
 * data/directional_outcomes.jsonl.
 *
 * Then prints a breakdown report: win rate by confidence bucket,
 * hour of day, and average entry price on wins vs losses.
 *
 * Run: node scripts/backfill-outcomes.js
 *      node scripts/backfill-outcomes.js --report-only   (skip fetch, just print report)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = path.join(__dirname, '..', 'data');
const ORDERS_FILE   = path.join(DATA_DIR, 'directional_orders.jsonl');
const OUTCOMES_FILE = path.join(DATA_DIR, 'directional_outcomes.jsonl');

const GAMMA_HOST = 'https://gamma-api.polymarket.com';
const REPORT_ONLY = process.argv.includes('--report-only');
const DELAY_MS = 200; // be polite to the API

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function readJsonl(filePath) {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line));
}

function computeFeeShares(shares, price) {
    return shares * 0.25 * Math.pow(price * (1 - price), 2);
}

function computeNetPayout(shares, price) {
    return (shares - computeFeeShares(shares, price)) * 1.0;
}

const SLOT_SEC = 900;

/**
 * Compute the slot timestamp for a given trade timestamp.
 * The trade fires N minutes into the slot, so we floor to the slot boundary.
 */
function slotFromTs(ts) {
    return Math.floor(new Date(ts).getTime() / 1000 / SLOT_SEC) * SLOT_SEC;
}

/**
 * Fetch market outcome from Gamma API using the btc-updown-15m-{slot} slug.
 * Returns { winner: 'UP'|'DOWN'|null, closed: bool } or null on error.
 *
 * outcomePrices: ["1","0"] means outcomes[0] won.
 * outcomes:      ["Up","Down"] — normalised to uppercase.
 */
async function fetchMarketOutcome(conditionId, ts, asset = 'btc') {
    try {
        const slot = slotFromTs(ts);
        const slug = `${asset}-updown-15m-${slot}`;
        const url  = `${GAMMA_HOST}/markets/slug/${slug}`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!resp.ok) return null;

        const market = await resp.json();
        if (!market || !market.conditionId) return null;

        const closed = market.closed || false;
        if (!closed) return { winner: null, closed: false };

        // outcomePrices may be a JSON string — parse if needed
        const rawPrices  = market.outcomePrices;
        const rawOutcomes = market.outcomes;
        const prices   = Array.isArray(rawPrices)  ? rawPrices  : JSON.parse(rawPrices  || '[]');
        const outcomes = Array.isArray(rawOutcomes) ? rawOutcomes : JSON.parse(rawOutcomes || '[]');

        if (!prices || !outcomes || prices.length < 2) return { winner: null, closed };

        const winIdx = prices.findIndex(p => parseFloat(p) === 1);
        if (winIdx === -1) return { winner: null, closed }; // not yet resolved

        const winOutcome = outcomes[winIdx].toUpperCase(); // "UP" or "DOWN"
        return { winner: winOutcome, closed: true };
    } catch (err) {
        console.error('    fetch error:', err.message);
        return null;
    }
}

// ── Phase 1: Backfill ─────────────────────────────────────────────────────────

async function backfill() {
    const orders = readJsonl(ORDERS_FILE);
    const placed  = orders.filter(o => o.status === 'placed');

    if (placed.length === 0) {
        console.log('No placed trades found in', ORDERS_FILE);
        return;
    }

    // Load already-processed conditionIds to allow re-runs without duplication
    const existing = new Set(
        readJsonl(OUTCOMES_FILE).map(o => o.conditionId)
    );

    const toProcess = placed.filter(o => !existing.has(o.conditionId));
    console.log(`Found ${placed.length} placed trades. ${existing.size} already processed. Fetching ${toProcess.length} new...`);

    let fetched = 0;
    let skippedOpen = 0;
    let errors = 0;

    for (const order of toProcess) {
        await sleep(DELAY_MS);

        const result = await fetchMarketOutcome(order.conditionId, order.ts, (order.asset || 'btc').toLowerCase());

        if (!result) {
            errors++;
            console.log(`  [ERROR] ${order.question}`);
            continue;
        }

        if (!result.closed) {
            skippedOpen++;
            continue;
        }

        const winner = result.winner; // 'UP', 'DOWN', or null (unresolved)
        const outcome = winner
            ? (order.direction === winner ? 'win' : 'loss')
            : 'unresolved';

        const entryPrice  = order.price;
        const shares      = order.shares;
        const netPayout   = outcome === 'win' ? computeNetPayout(shares, entryPrice) : 0;
        const netProfit   = netPayout - order.cost;

        const dt = new Date(order.ts);
        const record = {
            ts:            order.ts,
            conditionId:   order.conditionId,
            question:      order.question,
            signal:        order.signal,
            signalMinutes: order.signalMinutes,
            direction:     order.direction,
            winner,
            outcome,
            confidence:    order.confidence,
            price:         entryPrice,
            shares,
            cost:          order.cost,
            netPayout:     parseFloat(netPayout.toFixed(4)),
            netProfit:     parseFloat(netProfit.toFixed(4)),
            hour:          dt.getUTCHours(),
            dayOfWeek:     dt.getUTCDay(), // 0=Sun
            isDryRun:      order.orderId?.startsWith('sim-') ?? false,
        };

        fs.appendFileSync(OUTCOMES_FILE, JSON.stringify(record) + '\n', 'utf-8');
        fetched++;

        const tag = outcome === 'win' ? '✓' : outcome === 'loss' ? '✗' : '?';
        console.log(`  [${tag}] ${order.question} → ${winner ?? 'unresolved'} (conf: ${order.confidence?.toFixed(2) ?? 'n/a'})`);
    }

    console.log(`\nDone. Fetched: ${fetched}, Skipped (open): ${skippedOpen}, Errors: ${errors}`);
}

// ── Phase 2: Report ───────────────────────────────────────────────────────────

function printReport() {
    const outcomes = readJsonl(OUTCOMES_FILE).filter(o => o.outcome !== 'unresolved');

    if (outcomes.length === 0) {
        console.log('\nNo resolved outcomes to report yet.');
        return;
    }

    const liveOnly = outcomes.filter(o => !o.isDryRun);
    const set = liveOnly.length >= 5 ? liveOnly : outcomes; // fall back to all if few live trades
    const label = liveOnly.length >= 5 ? 'live' : 'all (including sim)';

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  DIRECTIONAL BOT OUTCOME REPORT  (${set.length} trades, ${label})`);
    console.log('═'.repeat(60));

    // Overall
    const wins = set.filter(o => o.outcome === 'win');
    const totalPnl = set.reduce((s, o) => s + o.netProfit, 0);
    const winRate = (wins.length / set.length * 100).toFixed(1);
    console.log(`\nOVERALL`);
    console.log(`  Win rate : ${winRate}%  (${wins.length}W / ${set.length - wins.length}L)`);
    console.log(`  Net PnL  : $${totalPnl.toFixed(2)}`);
    console.log(`  Avg cost : $${(set.reduce((s,o)=>s+o.cost,0)/set.length).toFixed(2)}/trade`);

    // By confidence bucket
    const buckets = [
        { label: '0.0–0.3', min: 0,   max: 0.3 },
        { label: '0.3–0.5', min: 0.3, max: 0.5 },
        { label: '0.5–0.7', min: 0.5, max: 0.7 },
        { label: '0.7–1.0', min: 0.7, max: 1.0 },
    ];
    console.log(`\nBY CONFIDENCE`);
    console.log(`  ${'Bucket'.padEnd(10)} ${'Trades'.padStart(6)} ${'Win%'.padStart(6)} ${'PnL'.padStart(8)}`);
    for (const b of buckets) {
        const group = set.filter(o => o.confidence != null && o.confidence >= b.min && o.confidence < b.max);
        if (group.length === 0) continue;
        const gw = group.filter(o => o.outcome === 'win').length;
        const gpnl = group.reduce((s,o)=>s+o.netProfit,0);
        console.log(`  ${b.label.padEnd(10)} ${String(group.length).padStart(6)} ${(gw/group.length*100).toFixed(1).padStart(5)}% ${('$'+gpnl.toFixed(2)).padStart(8)}`);
    }

    // By hour (UTC)
    const hourGroups = {};
    for (const o of set) {
        hourGroups[o.hour] = hourGroups[o.hour] || [];
        hourGroups[o.hour].push(o);
    }
    console.log(`\nBY HOUR (UTC)`);
    console.log(`  ${'Hour'.padEnd(8)} ${'Trades'.padStart(6)} ${'Win%'.padStart(6)} ${'PnL'.padStart(8)}`);
    for (const h of Object.keys(hourGroups).sort((a,b)=>a-b)) {
        const group = hourGroups[h];
        const gw = group.filter(o => o.outcome === 'win').length;
        const gpnl = group.reduce((s,o)=>s+o.netProfit,0);
        console.log(`  ${String(h).padEnd(8)} ${String(group.length).padStart(6)} ${(gw/group.length*100).toFixed(1).padStart(5)}% ${('$'+gpnl.toFixed(2)).padStart(8)}`);
    }

    // Entry price: wins vs losses
    const avgPriceWin  = wins.reduce((s,o)=>s+o.price,0) / (wins.length || 1);
    const losses = set.filter(o => o.outcome === 'loss');
    const avgPriceLoss = losses.reduce((s,o)=>s+o.price,0) / (losses.length || 1);
    console.log(`\nENTRY PRICE`);
    console.log(`  Avg price on wins  : ${avgPriceWin.toFixed(4)}`);
    console.log(`  Avg price on losses: ${avgPriceLoss.toFixed(4)}`);

    // Direction bias
    const upTrades   = set.filter(o => o.direction === 'UP');
    const downTrades = set.filter(o => o.direction === 'DOWN');
    const upWins     = upTrades.filter(o => o.outcome === 'win');
    const downWins   = downTrades.filter(o => o.outcome === 'win');
    console.log(`\nDIRECTION BIAS`);
    console.log(`  UP   : ${upTrades.length} trades, ${upTrades.length ? (upWins.length/upTrades.length*100).toFixed(1) : 'n/a'}% win rate`);
    console.log(`  DOWN : ${downTrades.length} trades, ${downTrades.length ? (downWins.length/downTrades.length*100).toFixed(1) : 'n/a'}% win rate`);

    console.log(`\n${'═'.repeat(60)}\n`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

if (!REPORT_ONLY) {
    await backfill();
}
printReport();
