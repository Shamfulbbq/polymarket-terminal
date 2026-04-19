/**
 * analyze_signal.mjs
 *
 * Replay historical ticks.jsonl through BookDeltaTracker to see what the
 * 3s/30s Polymarket book-delta signal would have shown at the critical
 * moments of each round.
 *
 * Why book-delta only? Old ticks don't have BTC aggTrade volume — that
 * field gets added by the new recorder. For the BTC flow signal we need
 * to wait for fresh data. The book-delta signal works on existing ticks.
 *
 * Usage:
 *   scp -i ... ubuntu@108.131.218.78:~/polymarket-terminal/data/btc5m/ticks.jsonl \
 *       data/btc5m/ticks.jsonl
 *   node src/btc5m/analyze_signal.mjs
 *
 * Output: summary table per round showing
 *   - whether the round went single-sided (one ask collapsed)
 *   - what spreadDelta30s looked like at the entry window (first 90s)
 *   - whether a sustained one-way book delta would have predicted it
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { BookDeltaTracker } from './signal.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..', '..');
const TICKS     = path.join(ROOT, 'data', 'btc5m', 'ticks.jsonl');
const ROUNDS    = path.join(ROOT, 'data', 'btc5m', 'rounds.jsonl');

if (!fs.existsSync(TICKS)) {
    console.error(`Missing ${TICKS}. Pull from Ireland first.`);
    process.exit(1);
}

// ── Load round outcomes ──────────────────────────────────────────────────────

const roundOutcome = new Map(); // slug -> 'UP'|'DN'|null
if (fs.existsSync(ROUNDS)) {
    const lines = fs.readFileSync(ROUNDS, 'utf8').split('\n').filter(Boolean);
    for (const ln of lines) {
        try {
            const r = JSON.parse(ln);
            if (r.resolved_label) roundOutcome.set(r.slug, r.resolved_label);
            else if (r.provisional_label && !roundOutcome.has(r.slug))
                roundOutcome.set(r.slug, r.provisional_label);
        } catch {}
    }
}
console.log(`Loaded ${roundOutcome.size} round outcomes\n`);

// ── Stream ticks, group by round ─────────────────────────────────────────────

async function processTicks() {
    const rl = readline.createInterface({
        input: fs.createReadStream(TICKS),
        crlfDelay: Infinity,
    });

    const rounds = new Map(); // slug -> { ticks: [], book: BookDeltaTracker }

    for await (const ln of rl) {
        if (!ln) continue;
        let t;
        try { t = JSON.parse(ln); } catch { continue; }
        if (!t.slug) continue;

        let r = rounds.get(t.slug);
        if (!r) {
            r = { ticks: [], book: new BookDeltaTracker() };
            rounds.set(t.slug, r);
        }

        // Feed book tracker if we have asks
        if (t.up_ask != null || t.dn_ask != null) {
            r.book.addSnap(t.up_ask, t.dn_ask, t.ts);
        }
        const sig = r.book.compute(t.ts);
        r.ticks.push({
            ts: t.ts,
            time_rem: t.time_rem,
            up_ask: t.up_ask,
            dn_ask: t.dn_ask,
            ...sig,
        });
    }
    return rounds;
}

// ── Per-round analysis ───────────────────────────────────────────────────────

function classifyRound(ticks) {
    // Simple heuristic for "single-sided" round:
    //   - At some point in entry window (time_rem >= 210, i.e. first 90s of 5m round),
    //     one ask drops by >= 0.20 over a 30s window while the other RISES by >= 0.10
    const entry = ticks.filter(t => t.time_rem >= 210); // first 90s
    let maxOneSidedness = 0;
    let trigTick = null;
    for (const t of entry) {
        if (t.upAskDelta30s == null || t.dnAskDelta30s == null) continue;
        // UP collapsing while DN rising
        if (t.upAskDelta30s < -0.15 && t.dnAskDelta30s > 0.10) {
            const score = -t.upAskDelta30s + t.dnAskDelta30s;
            if (score > maxOneSidedness) { maxOneSidedness = score; trigTick = { ...t, dir: 'DN_DOMINANT' }; }
        }
        // DN collapsing while UP rising
        if (t.dnAskDelta30s < -0.15 && t.upAskDelta30s > 0.10) {
            const score = -t.dnAskDelta30s + t.upAskDelta30s;
            if (score > maxOneSidedness) { maxOneSidedness = score; trigTick = { ...t, dir: 'UP_DOMINANT' }; }
        }
    }
    return { oneSided: maxOneSidedness > 0.30, trigTick, score: maxOneSidedness };
}

function summarize(slug, ticks) {
    if (ticks.length < 30) return null;
    const c = classifyRound(ticks);
    const outcome = roundOutcome.get(slug) || '?';
    const lastUp = ticks[ticks.length - 1].up_ask;
    const lastDn = ticks[ticks.length - 1].dn_ask;
    return {
        slug,
        outcome,
        ticks: ticks.length,
        oneSided: c.oneSided,
        score: c.score.toFixed(2),
        triggerDir: c.trigTick?.dir ?? '-',
        triggerTimeRem: c.trigTick?.time_rem ?? '-',
        triggerSpread30s: c.trigTick ? `up${c.trigTick.upAskDelta30s} dn${c.trigTick.dnAskDelta30s}` : '-',
        endUpAsk: lastUp,
        endDnAsk: lastDn,
    };
}

// ── Main ─────────────────────────────────────────────────────────────────────

(async () => {
    console.log('Streaming ticks.jsonl...');
    const rounds = await processTicks();
    console.log(`Parsed ${rounds.size} rounds`);
    console.log();

    const rows = [];
    for (const [slug, r] of rounds) {
        const s = summarize(slug, r.ticks);
        if (s) rows.push(s);
    }

    // Stats
    const total = rows.length;
    const oneSided = rows.filter(r => r.oneSided);
    const oneSidedDN = oneSided.filter(r => r.triggerDir === 'DN_DOMINANT');
    const oneSidedUP = oneSided.filter(r => r.triggerDir === 'UP_DOMINANT');

    console.log('=== SUMMARY ===');
    console.log(`Total rounds analyzed: ${total}`);
    console.log(`One-sided (book-delta predicted): ${oneSided.length} (${(100*oneSided.length/total).toFixed(1)}%)`);
    console.log(`  → DN dominant (UP collapse): ${oneSidedDN.length}`);
    console.log(`  → UP dominant (DN collapse): ${oneSidedUP.length}`);
    console.log();

    // Predictive accuracy: of one-sided rounds, how many resolved on the predicted side?
    const resolved = oneSided.filter(r => r.outcome !== '?');
    const correct = resolved.filter(r =>
        (r.triggerDir === 'DN_DOMINANT' && r.outcome === 'DN') ||
        (r.triggerDir === 'UP_DOMINANT' && r.outcome === 'UP')
    );
    if (resolved.length > 0) {
        console.log(`Of ${resolved.length} one-sided rounds with known outcome:`);
        console.log(`  Predicted side won: ${correct.length} (${(100*correct.length/resolved.length).toFixed(1)}%)`);
        console.log(`  → If accuracy >> 50%, signal is real`);
        console.log();
    }

    // Print last 30 one-sided rounds
    const recent = rows.slice(-50);
    console.log('=== LAST 50 ROUNDS ===');
    console.log('slug                              outcome  oneSided  score  dir          trigTimeRem');
    for (const r of recent) {
        console.log(
            r.slug.padEnd(36),
            r.outcome.padEnd(7),
            (r.oneSided ? 'YES' : '   ').padEnd(8),
            r.score.padStart(5),
            r.triggerDir.padEnd(13),
            String(r.triggerTimeRem).padStart(8),
        );
    }
})();
