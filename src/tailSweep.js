/**
 * tailSweep.js
 * Entry point for the Tail-Sweep bot.
 * Monitors 5-minute markets and buys the dominant side in the final seconds
 * when one side's best bid exceeds a threshold (e.g. $0.90).
 *
 * Run with: npm run tailsweep       (live)
 *           npm run tailsweep-sim   (simulation / paper trading)
 *
 * Paper mode tests ALL threshold/size combos simultaneously and tracks
 * simulated PnL for each, so you can find the optimal configuration.
 */

import { validateTailSweepConfig } from './config/index.js';
import config from './config/index.js';
import logger from './utils/logger.js';
import { initClient, initClientWithKeys } from './services/client.js';
import { getUsdcBalance } from './services/client.js';
import { initDashboard, appendLog, updateStatus, isDashboardActive } from './ui/dashboard.js';
import { startSniperDetector, stopSniperDetector } from './services/sniperDetector.js';
import { start15mDetector, stop15mDetector } from './services/fifteenMinDetector.js';
import { scheduleTailSweep, getTrades, getPendingCount, getPaperStats, cancelAllPending, getLiveStats } from './services/tailSweepExecutor.js';
import { redeemMMPositions } from './services/ctf.js';
import { initBalanceLedger, logBalance, getBalancePnl } from './utils/balanceLedger.js';

// ── Validate config ────────────────────────────────────────────────────────────

try {
    validateTailSweepConfig();
} catch (err) {
    console.error(`Config error: ${err.message}`);
    process.exit(1);
}

if (config.tailSweepAssets.length === 0) {
    console.error('TAIL_SWEEP_ASSETS is empty. Set e.g. TAIL_SWEEP_ASSETS=btc,eth,sol in .env');
    process.exit(1);
}

// ── Init TUI ──────────────────────────────────────────────────────────────────

initDashboard();
logger.setOutput(appendLog);

// ── Init CLOB client ──────────────────────────────────────────────────────────

try {
    await initClientWithKeys(config.tailSweepPrivateKey, config.tailSweepProxyWallet);
} catch (err) {
    logger.error(`Client init error: ${err.message}`);
    process.exit(1);
}

initBalanceLedger(getUsdcBalance);
if (!config.dryRun) {
    await logBalance('session_start', { strategy: 'tailsweep', threshold: config.tailSweepThreshold });
}

// ── Status panel ──────────────────────────────────────────────────────────────

async function buildStatusContent() {
    const lines = [];

    // Balance
    let balance = '?';
    if (!config.dryRun) {
        try { balance = (await getUsdcBalance()).toFixed(2); } catch { /* ignore */ }
    } else {
        balance = '{yellow-fg}SIM{/yellow-fg}';
    }
    lines.push('{bold}BALANCE{/bold}');
    lines.push(`  USDC.e: {green-fg}$${balance}{/green-fg}`);
    lines.push('');

    lines.push('{bold}MODE{/bold}');
    lines.push(`  ${config.dryRun ? '{yellow-fg}PAPER TRADING{/yellow-fg}' : '{green-fg}LIVE{/green-fg}'}`);
    lines.push('');

    lines.push('{bold}TAIL SWEEP CONFIG{/bold}');
    lines.push(`  Assets     : ${config.tailSweepAssets.join(', ').toUpperCase()}`);
    lines.push(`  Threshold  : $${config.tailSweepThreshold} (bid must exceed)`);
    lines.push(`  Shares     : ${config.tailSweepShares} per trade`);
    lines.push(`  Entry at   : T-${config.tailSweepSecondsBefore}s before close`);
    lines.push(`  Min liq    : ${config.tailSweepMinLiquidity} shares on ask`);
    lines.push('');

    // Pending
    lines.push(`{bold}PENDING{/bold}: ${getPendingCount()} markets queued`);
    lines.push('');

    // Paper stats
    if (config.dryRun) {
        const ps = getPaperStats();
        const keys = Object.keys(ps).sort();
        if (keys.length > 0) {
            lines.push('{bold}PAPER STATS (threshold-shares){/bold}');
            for (const key of keys) {
                const s = ps[key];
                if (s.trades === 0) continue;
                const wr = s.trades > 0 ? ((s.wins / s.trades) * 100).toFixed(1) : '0';
                const sign = s.pnl >= 0 ? '+' : '';
                const color = s.pnl >= 0 ? 'green-fg' : 'red-fg';
                lines.push(`  {cyan-fg}$${key}{/cyan-fg} : ${s.trades} trades | ${s.wins}W | ${wr}% | {${color}}${sign}$${s.pnl.toFixed(2)}{/${color}}`);
            }
            lines.push('');
        }
    }

    // Recent trades
    const trades = getTrades();
    const recent = trades.slice(-12).reverse();
    lines.push(`{bold}RECENT TRADES (${trades.length} total){/bold}`);
    if (recent.length === 0) {
        lines.push('  {gray-fg}Waiting for markets near close...{/gray-fg}');
    } else {
        for (const t of recent) {
            const paper = t.paper ? '[P] ' : '';
            if (t.paper) {
                const winLoss = t.won ? '{green-fg}WIN{/green-fg}' : '{red-fg}LOSS{/red-fg}';
                const pnlStr = t.pnl >= 0 ? `+$${t.pnl.toFixed(2)}` : `-$${Math.abs(t.pnl).toFixed(2)}`;
                lines.push(`  ${paper}{cyan-fg}${t.asset}{/cyan-fg} ${t.side} @ $${t.price.toFixed(2)} × ${t.shares}sh th=$${t.threshold} | ${winLoss} ${pnlStr}`);
            } else {
                const profit = t.netPayout ? `profit $${(t.netPayout - t.cost).toFixed(2)}` : '';
                lines.push(`  {cyan-fg}${t.asset}{/cyan-fg} ${t.side} @ $${t.price.toFixed(2)} × ${t.shares}sh | cost $${t.cost.toFixed(2)} ${profit}`);
            }
        }
    }

    // Balance PnL (live only)
    if (!config.dryRun) {
        try {
            const pnl = getBalancePnl();
            if (pnl) {
                lines.push('');
                lines.push('{bold}BALANCE PNL (on-chain){/bold}');
                lines.push(`  Session start : $${pnl.sessionStartBalance.toFixed(2)}`);
                lines.push(`  Current       : $${pnl.currentBalance.toFixed(2)}`);
                const sign = pnl.sessionPnl >= 0 ? '+' : '';
                const color = pnl.sessionPnl >= 0 ? 'green-fg' : 'red-fg';
                lines.push(`  Session PnL   : {${color}}${sign}$${pnl.sessionPnl.toFixed(2)}{/${color}}`);
            }
        } catch { /* ignore */ }
    }

    return '\n' + lines.join('\n');
}

let refreshTimer = null;
let redeemTimer  = null;
let balanceSnapshotTimer = null;

function startRefresh() {
    refreshTimer = setInterval(async () => {
        if (!isDashboardActive()) return;
        updateStatus(await buildStatusContent());
    }, 3000);
    buildStatusContent().then(updateStatus);
}

function startRedeemer() {
    redeemMMPositions().catch((err) => logger.error('Tail-sweep redeemer error:', err.message));
    redeemTimer = setInterval(
        () => redeemMMPositions().catch((err) => logger.error('Tail-sweep redeemer error:', err.message)),
        config.redeemInterval,
    );
    logger.info(`Redeemer started — checking every ${config.redeemInterval / 1000}s`);
}

const BALANCE_SNAPSHOT_MS = 5 * 60 * 1000;

function startBalanceSnapshots() {
    if (config.dryRun) return;
    balanceSnapshotTimer = setInterval(
        () => logBalance('periodic').catch(() => {}),
        BALANCE_SNAPSHOT_MS,
    );
}

// ── Market handler ────────────────────────────────────────────────────────────

async function handleNewMarket(market) {
    if (!config.tailSweepAssets.includes(market.asset)) return;
    scheduleTailSweep(market);
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

async function shutdown() {
    logger.warn('TAILSWEEP: shutting down...');
    stopSniperDetector();
    stop15mDetector();
    cancelAllPending();
    if (refreshTimer) clearInterval(refreshTimer);
    if (redeemTimer) clearInterval(redeemTimer);
    if (balanceSnapshotTimer) clearInterval(balanceSnapshotTimer);
    if (!config.dryRun) {
        try { await logBalance('session_end'); } catch { /* best effort */ }
    }
    process.exit(0);
}

process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);

// ── Start ─────────────────────────────────────────────────────────────────────

logger.info(`TAILSWEEP starting — ${config.dryRun ? 'PAPER TRADING' : 'LIVE'}`);
logger.info(`Assets: ${config.tailSweepAssets.join(', ').toUpperCase()} | Threshold: $${config.tailSweepThreshold} | Shares: ${config.tailSweepShares} | Entry: T-${config.tailSweepSecondsBefore}s`);

if (config.dryRun) {
    logger.info('PAPER mode — testing thresholds [$0.85, $0.88, $0.90, $0.92, $0.95] × shares [5, 10] simultaneously');
}

startRefresh();
if (!config.dryRun) startRedeemer();
startBalanceSnapshots();

// Reuse sniperDetector — it detects all 5-min markets for the configured SNIPER_ASSETS
// We temporarily override the asset list so the detector picks up our tail-sweep assets too
const origAssets = config.sniperAssets;
config.sniperAssets = [...new Set([...origAssets, ...config.tailSweepAssets])];
startSniperDetector(handleNewMarket);

// 15-minute markets (optional)
if (config.tailSweep15m) {
    start15mDetector(handleNewMarket);
    logger.info('TAILSWEEP: 15-minute market detection enabled');
}
