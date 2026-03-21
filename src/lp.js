/**
 * lp.js
 * Liquidity Provider bot — earns Polymarket liquidity rewards by posting
 * two-sided quotes on selected markets.
 *
 * Uses tailsweep wallet for trading.
 * Run with: npm run lp
 */

import config from './config/index.js';
import logger from './utils/logger.js';
import { initClientWithKeys, getUsdcBalance } from './services/client.js';
import { scanForTargets } from './services/rewardScanner.js';
import { postQuotes, checkFills, cancelAllOrders, refreshAllQuotes, checkStalePositions, LP_CONFIG, getActiveQuotes } from './services/lpExecutor.js';
import * as risk from './services/riskManager.js';

// ── Use tailsweep wallet ────────────────────────────────────────────────────

const LP_PRIVATE_KEY = config.tailSweepPrivateKey;
const LP_PROXY_WALLET = config.tailSweepProxyWallet;

if (!LP_PRIVATE_KEY || !LP_PROXY_WALLET) {
    console.error('Missing TAILSWEEP_PRIVATE_KEY or TAILSWEEP_PROXY_WALLET_ADDRESS in .env');
    process.exit(1);
}

// ── Init ────────────────────────────────────────────────────────────────────

logger.info('LP BOT starting...');
logger.info(`Mode: ${config.dryRun ? 'DRY RUN' : 'LIVE'}`);

try {
    await initClientWithKeys(LP_PRIVATE_KEY, LP_PROXY_WALLET);
} catch (err) {
    logger.error(`Client init failed: ${err.message}`);
    process.exit(1);
}

// ── Check balance ───────────────────────────────────────────────────────────

let balance = 0;
try {
    balance = await getUsdcBalance();
    logger.info(`Balance: $${balance.toFixed(2)}`);
} catch (err) {
    logger.warn(`Balance check failed: ${err.message}`);
}

// ── Scan for target markets ─────────────────────────────────────────────────

let targetMarkets = [];

async function rescan() {
    try {
        logger.info('LP: scanning for reward markets...');
        targetMarkets = await scanForTargets({
            minDailyReward: 1.0,
            priceMin: 0.15,
            priceMax: 0.85,
            maxMarkets: 5,
        });

        if (targetMarkets.length === 0) {
            logger.warn('LP: no suitable reward markets found');
        } else {
            logger.info(`LP: targeting ${targetMarkets.length} markets:`);
            for (const m of targetMarkets) {
                logger.info(`  $${m.dailyReward.toFixed(1)}/day | $${m.yesPrice.toFixed(2)} | ${m.question?.slice(0, 50)}`);
            }
        }
    } catch (err) {
        logger.error(`LP: scan failed — ${err.message}`);
    }
}

await rescan();

// ── Main loop ───────────────────────────────────────────────────────────────

let cycleCount = 0;

async function mainLoop() {
    cycleCount++;

    // Re-scan markets every 30 cycles (~30 min)
    if (cycleCount % 30 === 0) {
        await rescan();
    }

    // Check fills on existing quotes
    try {
        await checkFills();
    } catch (err) {
        logger.warn(`LP: fill check error — ${err.message}`);
    }

    // Force-sell stale positions
    try {
        await checkStalePositions();
    } catch (err) {
        logger.warn(`LP: stale position check error — ${err.message}`);
    }

    // Refresh quotes every cycle
    try {
        await refreshAllQuotes(targetMarkets);
    } catch (err) {
        logger.warn(`LP: refresh error — ${err.message}`);
    }

    // Log status every 5 cycles
    if (cycleCount % 5 === 0) {
        const summary = risk.getSummary();
        const quotes = getActiveQuotes();
        try {
            const bal = await getUsdcBalance();
            logger.info(
                `LP STATUS: bal=$${bal.toFixed(2)} | PnL=$${summary.dailyPnl.toFixed(2)} | ` +
                `exposure=$${summary.totalExposure.toFixed(2)} | markets=${quotes.size} | ` +
                `cycle=${cycleCount}${summary.halted ? ' | HALTED' : ''}`
            );
        } catch {
            logger.info(`LP STATUS: PnL=$${summary.dailyPnl.toFixed(2)} | cycle=${cycleCount}`);
        }
    }
}

// Run main loop every 60s
const loopInterval = setInterval(mainLoop, LP_CONFIG.refreshIntervalMs);

// Also check fills more frequently (every 15s)
const fillInterval = setInterval(async () => {
    try { await checkFills(); } catch {}
}, LP_CONFIG.fillCheckIntervalMs);

// ── Graceful shutdown ───────────────────────────────────────────────────────

async function shutdown() {
    logger.info('LP: shutting down — cancelling all orders...');
    clearInterval(loopInterval);
    clearInterval(fillInterval);
    try {
        await cancelAllOrders();
    } catch (err) {
        logger.warn(`LP: cancel error during shutdown — ${err.message}`);
    }
    const summary = risk.getSummary();
    logger.info(`LP: final PnL today: $${summary.dailyPnl.toFixed(2)}`);
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start immediately
logger.info('LP BOT running — Ctrl+C to stop');
await mainLoop();
