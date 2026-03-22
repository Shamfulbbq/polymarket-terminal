/**
 * directionalSniper.js
 * Entry point for the BTC 15-minute Directional Sniper bot.
 *
 * Reads real-time Binance kline data, detects Polymarket 15m BTC markets,
 * waits N minutes for a signal, and places a single-direction bet.
 *
 * Run with: npm run directional       (live)
 *           npm run directional-sim   (simulation)
 */

import { validateDirectionalConfig } from './config/index.js';
import config from './config/index.js';
import logger from './utils/logger.js';
import { initClient, getUsdcBalance } from './services/client.js';
import { initDashboard, appendLog, updateStatus, isDashboardActive } from './ui/dashboard.js';
import { startBinanceFeed, stopBinanceFeed, getBinanceFeedStatus } from './services/binanceFeed.js';
import { startDirectionalDetector, stopDirectionalDetector } from './services/directionalDetector.js';
import { startTimeframeDetector, stopTimeframeDetector } from './services/cryptoTimeframeDetector.js';
import { scheduleDirectionalTrade, getActiveTrades, getPendingCount, cancelAllPending, getDailySpendTotal } from './services/directionalExecutor.js';
import { redeemMMPositions } from './services/ctf.js';
import { initBalanceLedger, logBalance, getBalancePnl } from './utils/balanceLedger.js';

// ── Validate config ────────────────────────────────────────────────────────────

try {
    validateDirectionalConfig();
} catch (err) {
    console.error(`Config error: ${err.message}`);
    process.exit(1);
}

// ── Init TUI ──────────────────────────────────────────────────────────────────

initDashboard();
logger.setOutput(appendLog);

// ── Init CLOB client ──────────────────────────────────────────────────────────

try {
    await initClient();
} catch (err) {
    logger.error(`Client init error: ${err.message}`);
    process.exit(1);
}

initBalanceLedger(getUsdcBalance);
if (!config.dryRun) {
    await logBalance('session_start', { strategy: 'directional', asset: config.directionalAsset, signal: config.directionalSignal });
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
    lines.push(`  ${config.dryRun ? '{yellow-fg}SIMULATION{/yellow-fg}' : '{green-fg}LIVE{/green-fg}'}`);
    lines.push('');

    // Config with fee-adjusted figures
    const ep = config.directionalEntryPrice;
    const sh = config.directionalShares;
    const cost = (ep * sh).toFixed(2);
    const feeShares = sh * 0.25 * Math.pow(ep * (1 - ep), 2);
    const netPayout = ((sh - feeShares) * 1.0).toFixed(2);
    const netProfit = ((sh - feeShares) - ep * sh).toFixed(2);
    lines.push('{bold}DIRECTIONAL SNIPER CONFIG{/bold}');
    lines.push(`  Asset      : ${config.directionalAsset.toUpperCase()} | Timeframes: ${config.directionalTimeframes.join(', ')}`);
    lines.push(`  Signal     : ${config.directionalSignal} (${config.directionalSignalMinutes}min 15m / ${config.directional1hSignalMinutes}min 1h+)`);
    lines.push(`  Entry      : $${ep} per share | Max cap: $${config.directionalMaxEntryPrice}`);
    lines.push(`  Shares     : ${sh} per trade | Cost: $${cost} | Fee: ${feeShares.toFixed(3)}sh | Win payout: $${netPayout} | Win profit: $${netProfit}`);
    // Daily spend vs limit
    const dailySpent = getDailySpendTotal();
    const dailyColor = dailySpent >= config.directionalDailyLossLimit * 0.8 ? 'red-fg' : 'green-fg';
    lines.push(`  Daily spend: {${dailyColor}}$${dailySpent.toFixed(2)}{/${dailyColor}} / $${config.directionalDailyLossLimit} limit`);
    lines.push('');

    // Binance feed
    const feed = getBinanceFeedStatus();
    const feedColor = feed.status === 'connected' ? 'green-fg' : 'yellow-fg';
    const priceStr = feed.lastPrice ? `$${feed.lastPrice.toLocaleString()}` : 'N/A';
    const candleStr = feed.lastCandleTime || 'N/A';
    lines.push('{bold}BINANCE FEED{/bold}');
    lines.push(`  Status: {${feedColor}}${feed.status}{/${feedColor}} | BTC: ${priceStr} | Candles: ${feed.bufferedCandles}`);
    const obiStr = feed.obi != null ? `OBI: ${feed.obi > 0 ? '+' : ''}${feed.obi}` : '';
    const cvdStr = feed.cvd != null ? `CVD: ${feed.cvd > 0 ? '+' : ''}${feed.cvd}` : '';
    const tickStr = feed.aggTradeCount != null ? `Ticks: ${feed.aggTradeCount}` : '';
    lines.push(`  Last candle: ${candleStr} | ${obiStr} ${cvdStr} ${tickStr}`);
    lines.push('');

    // Pending signals
    const pending = getPendingCount();
    if (pending > 0) {
        lines.push(`{bold}PENDING SIGNALS{/bold}: ${pending} market(s) awaiting signal window`);
        lines.push('');
    }

    // Recent trades
    const trades = getActiveTrades();
    lines.push(`{bold}RECENT TRADES (${trades.length} total){/bold}`);

    if (trades.length === 0) {
        lines.push('  {gray-fg}Waiting for markets...{/gray-fg}');
    } else {
        const recent = trades.slice(-10).reverse();
        let wins = 0, losses = 0, totalPnl = 0;
        for (const t of trades) {
            // Rough PnL: if potentialPayout and cost are set, a "win" = payout - cost, "loss" = -cost
            // (actual outcome unknown until market resolves; shown for tracking)
        }
        for (const t of recent) {
            const conf = t.confidence != null ? ` (${(t.confidence * 100).toFixed(0)}%)` : '';
            const dirColor = t.direction === 'UP' ? 'green-fg' : 'red-fg';
            const payoutStr = t.potentialPayout != null ? ` | win $${t.potentialPayout}` : '';
            lines.push(`  {${dirColor}}${t.direction}{/${dirColor}} @ $${t.price} × ${t.shares}sh | cost $${t.cost.toFixed(2)}${payoutStr}${conf}`);
        }
    }
    lines.push('');

    // Session PnL (on-chain)
    try {
        const pnl = getBalancePnl();
        if (pnl) {
            lines.push('{bold}BALANCE PNL (on-chain){/bold}');
            lines.push(`  Session start : $${pnl.sessionStartBalance.toFixed(2)} (${pnl.sessionStartTs.slice(0, 16).replace('T', ' ')})`);
            lines.push(`  Current       : $${pnl.currentBalance.toFixed(2)}`);
            const sign = pnl.sessionPnl >= 0 ? '+' : '';
            const color = pnl.sessionPnl >= 0 ? 'green-fg' : 'red-fg';
            lines.push(`  Session PnL   : {${color}}${sign}$${pnl.sessionPnl.toFixed(2)}{/${color}}`);
        }
    } catch { /* ignore */ }

    return '\n' + lines.join('\n');
}

// ── Timers ─────────────────────────────────────────────────────────────────────

let refreshTimer = null;
let redeemTimer = null;
let balanceSnapshotTimer = null;

function startRefresh() {
    refreshTimer = setInterval(async () => {
        if (!isDashboardActive()) return;
        updateStatus(await buildStatusContent());
    }, 3000);
    buildStatusContent().then(updateStatus);
}

function startRedeemer() {
    redeemMMPositions().catch((err) => logger.error('Directional redeemer error:', err.message));
    redeemTimer = setInterval(
        () => redeemMMPositions().catch((err) => logger.error('Directional redeemer error:', err.message)),
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

function handleNewMarket(market) {
    logger.info(`DIRECTIONAL: new market detected — "${(market.question || '').slice(0, 50)}"`);
    scheduleDirectionalTrade(market);
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

async function shutdown() {
    logger.warn('DIRECTIONAL: shutting down...');
    stopDirectionalDetector();
    stopTimeframeDetector();
    stopBinanceFeed();
    cancelAllPending();
    if (refreshTimer) clearInterval(refreshTimer);
    if (redeemTimer) clearInterval(redeemTimer);
    if (balanceSnapshotTimer) clearInterval(balanceSnapshotTimer);
    if (!config.dryRun) {
        try { await logBalance('session_end'); } catch { /* best effort */ }
    }
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ── Start ─────────────────────────────────────────────────────────────────────

const cost = (config.directionalEntryPrice * config.directionalShares).toFixed(2);
logger.info(`DIRECTIONAL SNIPER V2 starting — ${config.dryRun ? 'SIMULATION' : 'LIVE'}`);
logger.info(`Asset: ${config.directionalAsset.toUpperCase()} | Timeframes: ${config.directionalTimeframes.join(', ')} | Signal: ${config.directionalSignal} (${config.directionalSignalMinutes}min/15m, ${config.directional1hSignalMinutes}min/1h+)`);
logger.info(`Entry: $${config.directionalEntryPrice} × ${config.directionalShares}sh = $${cost}/trade | Max cap: $${config.directionalMaxEntryPrice} | Daily limit: $${config.directionalDailyLossLimit}`);

startBinanceFeed();
startRefresh();
startRedeemer();
startBalanceSnapshots();

// 15m detector (always active)
if (config.directionalTimeframes.includes('15m')) {
    startDirectionalDetector(handleNewMarket);
}

// 1H/4H detector (opt-in via DIRECTIONAL_TIMEFRAMES)
const longTimeframes = config.directionalTimeframes.filter((tf) => tf !== '15m');
if (longTimeframes.length > 0) {
    startTimeframeDetector(longTimeframes, [config.directionalAsset], handleNewMarket);
    logger.info(`DIRECTIONAL: long-timeframe detector started — ${longTimeframes.join(', ')}`);
}
