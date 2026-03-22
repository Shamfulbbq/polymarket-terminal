/**
 * lp_farm.js
 * Reward farming bot — posts bid-only orders at the outer edge of the
 * reward zone to collect Polymarket liquidity rewards without taking fills.
 *
 * Run with: npm run farm         (live)
 *           npm run farm:paper   (paper mode)
 */

import config from './config/index.js';
import logger from './utils/logger.js';
import { initClientWithKeys } from './services/client.js';
import { scanForTargets } from './services/rewardScanner.js';
import { refreshAllFarmOrders, cancelAllFarmOrders, getFarmStats } from './services/rewardFarmer.js';

// ── Use tailsweep wallet ────────────────────────────────────────────────────

const FARM_KEY = config.tailSweepPrivateKey;
const FARM_WALLET = config.tailSweepProxyWallet;

if (!FARM_KEY || !FARM_WALLET) {
    console.error('Missing TAILSWEEP_PRIVATE_KEY or TAILSWEEP_PROXY_WALLET_ADDRESS in .env');
    process.exit(1);
}

logger.info(`FARM BOT starting — ${config.dryRun ? 'PAPER MODE' : 'LIVE'}`);

try {
    await initClientWithKeys(FARM_KEY, FARM_WALLET);
} catch (err) {
    logger.error(`Client init failed: ${err.message}`);
    process.exit(1);
}

// ── Scan for reward markets ─────────────────────────────────────────────────

let targetMarkets = [];

async function rescan() {
    try {
        logger.info('FARM: scanning for reward markets...');
        targetMarkets = await scanForTargets({
            minDailyReward: 1,
            priceMin: 0.05,
            priceMax: 0.95,
            maxMarkets: 10,       // farm many markets at once (low capital per order)
        });

        if (targetMarkets.length === 0) {
            logger.warn('FARM: no reward markets found');
        } else {
            logger.info(`FARM: targeting ${targetMarkets.length} markets:`);
            for (const m of targetMarkets) {
                logger.info(`  $${m.dailyReward.toFixed(1)}/day | min=${m.minSize}sh | $${m.yesPrice.toFixed(2)} | ${m.question?.slice(0, 50)}`);
            }
        }
    } catch (err) {
        logger.error(`FARM: scan failed — ${err.message}`);
    }
}

await rescan();

// ── Main loop ───────────────────────────────────────────────────────────────

let cycleCount = 0;

async function mainLoop() {
    cycleCount++;

    // Rescan every 30 cycles (~30 min)
    if (cycleCount % 30 === 0) {
        await rescan();
    }

    // Refresh farm orders
    try {
        await refreshAllFarmOrders(targetMarkets);
    } catch (err) {
        logger.warn(`FARM: refresh error — ${err.message}`);
    }
}

const loopInterval = setInterval(mainLoop, 60_000);

// ── Shutdown ────────────────────────────────────────────────────────────────

async function shutdown() {
    logger.info('FARM: shutting down — cancelling all orders...');
    clearInterval(loopInterval);
    try {
        await cancelAllFarmOrders();
    } catch (err) {
        logger.warn(`FARM: cancel error — ${err.message}`);
    }
    const stats = getFarmStats();
    logger.info(`FARM: final stats:`);
    logger.info(`  Markets: ${stats.marketsActive}`);
    logger.info(`  In-zone rate: ${stats.inZoneRate}`);
    logger.info(`  Est. rewards: $${stats.estimatedRewardsPerDay.toFixed(4)}`);
    logger.info(`  Accidental fills: ${stats.accidentalFills}`);
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

logger.info('FARM BOT running — Ctrl+C to stop');
await mainLoop();
