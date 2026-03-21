/**
 * lp_paper.js
 * Paper trading mode for the LP bot — simulates quoting on large reward markets
 * with $500 virtual capital. No real orders are placed.
 *
 * Targets 200sh markets ($50+/day rewards): Newsom, Vance, Starmer, etc.
 * Run with: npm run lp:paper
 */

import config from './config/index.js';
import logger from './utils/logger.js';
import { initClientWithKeys } from './services/client.js';
import { scanForTargets } from './services/rewardScanner.js';
import { checkFills, cancelAllOrders, refreshAllQuotes, checkStalePositions, LP_CONFIG, getActiveQuotes, getPaperStatus } from './services/lpExecutor.js';

// Override for paper mode:
// Target 20sh liquid markets — much cheaper orders ($2-18 per side)
LP_CONFIG.minOrderShares = 20;        // match the 20sh market minimum
LP_CONFIG.maxOrderSizeUsd = 50;       // plenty for 20sh orders
LP_CONFIG.maxExposureUsd = 200;       // cap total across all 5 markets
LP_CONFIG.maxPositionShares = 40;     // max 2 fills per side before pausing

// Ensure paper mode is set
if (process.env.LP_PAPER !== 'true') {
    console.error('LP_PAPER env var must be "true" — run via: npm run lp:paper');
    process.exit(1);
}

// ── Init (needs real client to fetch orderbooks, but no real orders) ─────────

const LP_PRIVATE_KEY = config.tailSweepPrivateKey;
const LP_PROXY_WALLET = config.tailSweepProxyWallet;

if (!LP_PRIVATE_KEY || !LP_PROXY_WALLET) {
    console.error('Missing TAILSWEEP_PRIVATE_KEY or TAILSWEEP_PROXY_WALLET_ADDRESS in .env');
    process.exit(1);
}

logger.info('LP PAPER BOT starting — $500 virtual capital, NO real orders');

try {
    await initClientWithKeys(LP_PRIVATE_KEY, LP_PROXY_WALLET);
} catch (err) {
    logger.error(`Client init failed: ${err.message}`);
    process.exit(1);
}

// ── Scan for large-reward markets (200sh minimum, $50+/day) ──────────────────

let targetMarkets = [];

async function rescan() {
    try {
        logger.info('LP PAPER: scanning for liquid reward markets (20sh, $20k+ vol)...');
        targetMarkets = await scanForTargets({
            minDailyReward: 1,
            maxOrderBudget: 50,       // prefer cheap 20sh markets (~$10/order), skip 200sh monsters
            priceMin: 0.05,
            priceMax: 0.95,
            minVolume: 20000,         // $20k+ daily volume — enough for exits to fill
            maxMarkets: 5,
        });

        if (targetMarkets.length === 0) {
            logger.warn('LP PAPER: no $20k+ vol markets — falling back to all rewards...');
            targetMarkets = await scanForTargets({
                minDailyReward: 1,
                maxOrderBudget: 200,
                priceMin: 0.05,
                priceMax: 0.95,
                maxMarkets: 3,
            });
        }

        if (targetMarkets.length === 0) {
            logger.warn('LP PAPER: no suitable markets found');
        } else {
            logger.info(`LP PAPER: targeting ${targetMarkets.length} markets:`);
            for (const m of targetMarkets) {
                const book = m.yesBook;
                logger.info(
                    `  $${m.dailyReward.toFixed(1)}/day | min=${m.minSize}sh | ` +
                    `spread=${book ? (book.bestAsk - book.bestBid).toFixed(2) : '?'} | ` +
                    `$${m.yesPrice.toFixed(2)} | ${m.question?.slice(0, 50)}`
                );
            }
        }
    } catch (err) {
        logger.error(`LP PAPER: scan failed — ${err.message}`);
    }
}

await rescan();

// ── Main loop ────────────────────────────────────────────────────────────────

let cycleCount = 0;

async function mainLoop() {
    cycleCount++;

    // Re-scan every 30 cycles (~30 min)
    if (cycleCount % 30 === 0) {
        await rescan();
    }

    // Check fills (simulated)
    try {
        await checkFills();
    } catch (err) {
        logger.warn(`LP PAPER: fill check error — ${err.message}`);
    }

    // Force-sell stale positions
    try {
        await checkStalePositions();
    } catch (err) {
        logger.warn(`LP PAPER: stale check error — ${err.message}`);
    }

    // Refresh quotes (simulated)
    try {
        await refreshAllQuotes(targetMarkets);
    } catch (err) {
        logger.warn(`LP PAPER: refresh error — ${err.message}`);
    }

    // Log paper status every 5 cycles
    if (cycleCount % 5 === 0) {
        const paper = getPaperStatus();
        const quotes = getActiveQuotes();
        logger.info(
            `LP PAPER STATUS | bal=$${paper.usdc.toFixed(2)} | ` +
            `totalVal=$${paper.totalValue.toFixed(2)} | ` +
            `pnl=$${paper.pnlRealized.toFixed(2)} | ` +
            `fills=${paper.fills} | markets=${quotes.size} | ` +
            `rewardZone=${paper.rewardCapture} | ` +
            `estRewards=$${paper.estimatedRewardsEarned.toFixed(4)} | ` +
            `cycle=${cycleCount}`
        );
    }
}

const loopInterval = setInterval(mainLoop, LP_CONFIG.refreshIntervalMs);

const fillInterval = setInterval(async () => {
    try { await checkFills(); } catch {}
}, LP_CONFIG.fillCheckIntervalMs);

// ── Shutdown ─────────────────────────────────────────────────────────────────

async function shutdown() {
    logger.info('LP PAPER: shutting down...');
    clearInterval(loopInterval);
    clearInterval(fillInterval);
    await cancelAllOrders();
    const paper = getPaperStatus();
    logger.info(`LP PAPER: final summary:`);
    logger.info(`  Virtual balance: $${paper.usdc.toFixed(2)}`);
    logger.info(`  Total value:     $${paper.totalValue.toFixed(2)}`);
    logger.info(`  Realized PnL:    $${paper.pnlRealized.toFixed(2)}`);
    logger.info(`  Fills:           ${paper.fills}`);
    logger.info(`  Reward zone:     ${paper.rewardCapture}`);
    logger.info(`  Est. rewards:    $${paper.estimatedRewardsEarned.toFixed(4)}`);
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

logger.info('LP PAPER BOT running — Ctrl+C to stop');
await mainLoop();
