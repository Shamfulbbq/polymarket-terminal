/**
 * cryptoMM.js
 * Entry point for the Crypto Market Maker bot.
 * Posts two-sided quotes on Polymarket 5-minute BTC/ETH/SOL markets
 * to earn maker rebates + liquidity rewards.
 *
 * Run with: npm run cmm         (live)
 *           npm run cmm:paper   (paper trading with $1000 virtual balance)
 */

import config from './config/index.js';
import logger from './utils/logger.js';
import { initClientWithKeys } from './services/client.js';
import { startBinanceFeed, stopBinanceFeed, getBinanceFeedStatus } from './services/binanceFeed.js';
import { startSniperDetector, stopSniperDetector } from './services/sniperDetector.js';
import { startTimeframeDetector, stopTimeframeDetector } from './services/cryptoTimeframeDetector.js';
import { scheduleMarket, getMMStats, cancelAllOrders, isDailyLossHit, CMM_ASSETS } from './services/cryptoMMExecutor.js';

// ── Validate ────────────────────────────────────────────────────────────────

if (CMM_ASSETS.length === 0) {
    console.error('CMM_ASSETS is empty. Set e.g. CMM_ASSETS=btc,eth,sol in .env');
    process.exit(1);
}

const CMM_PRIVATE_KEY = config.tailSweepPrivateKey || config.privateKey;
const CMM_PROXY_WALLET = config.tailSweepProxyWallet || config.proxyWallet;

if (!CMM_PRIVATE_KEY || !CMM_PROXY_WALLET) {
    console.error('Missing wallet keys. Set TAILSWEEP_PRIVATE_KEY + TAILSWEEP_PROXY_WALLET_ADDRESS (or PRIVATE_KEY + PROXY_WALLET_ADDRESS) in .env');
    process.exit(1);
}

// ── Init CLOB client ────────────────────────────────────────────────────────

try {
    await initClientWithKeys(CMM_PRIVATE_KEY, CMM_PROXY_WALLET);
} catch (err) {
    logger.error(`CMM: Client init error: ${err.message}`);
    process.exit(1);
}

// ── Market handler ──────────────────────────────────────────────────────────

function handleNewMarket(market) {
    if (!CMM_ASSETS.includes(market.asset?.toLowerCase())) return;
    scheduleMarket(market);
}

// ── Status logging ──────────────────────────────────────────────────────────

let statusTimer = null;

function logStatus() {
    const stats = getMMStats();
    const feed = getBinanceFeedStatus();
    const mode = config.dryRun ? 'PAPER' : 'LIVE';
    const feedStatus = feed.status === 'connected' ? 'OK' : feed.status;
    const priceStr = feed.lastPrice ? `$${feed.lastPrice.toLocaleString()}` : 'N/A';

    const dailyPnlStr = stats.dailyPnl >= 0 ? `+$${stats.dailyPnl.toFixed(2)}` : `-$${Math.abs(stats.dailyPnl).toFixed(2)}`;
    const lossLimit = isDailyLossHit() ? ' [LOSS LIMIT HIT]' : '';

    logger.info(
        `CMM [${mode}] | active=${stats.activeMarkets} pending=${stats.pendingMarkets} | ` +
        `fills=${stats.fills} W=${stats.wins} L=${stats.losses} | ` +
        `daily=${dailyPnlStr}${lossLimit} | ` +
        `rewards~$${stats.dailyRewardEstimate.toFixed(2)} | ` +
        `feed=${feedStatus} BTC=${priceStr}` +
        (stats.paperBalance != null ? ` | paper=$${stats.paperBalance.toFixed(2)}` : '')
    );
}

// ── Graceful shutdown ───────────────────────────────────────────────────────

async function shutdown() {
    logger.warn('CMM: shutting down...');
    stopSniperDetector();
    stopTimeframeDetector();
    stopBinanceFeed();
    await cancelAllOrders();
    if (statusTimer) clearInterval(statusTimer);

    const stats = getMMStats();
    const dailyPnlStr = stats.dailyPnl >= 0 ? `+$${stats.dailyPnl.toFixed(2)}` : `-$${Math.abs(stats.dailyPnl).toFixed(2)}`;
    logger.info(`CMM: final stats — fills=${stats.fills} W=${stats.wins} L=${stats.losses} daily=${dailyPnlStr}`);

    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ── Start ───────────────────────────────────────────────────────────────────

const mode = config.dryRun ? 'PAPER ($1000 virtual)' : 'LIVE';
logger.info(`CMM starting — ${mode}`);
logger.info(`Assets: ${CMM_ASSETS.join(', ').toUpperCase()} | Spread: ${process.env.CMM_SPREAD || '0.04'} | Shares: ${process.env.CMM_SHARES || '20'} | Max daily loss: $${process.env.CMM_MAX_DAILY_LOSS || '50'}`);

// Start Binance feed for signal data
startBinanceFeed();

// Start sniper detector — it detects all 5-min markets
// Override sniper assets to include our CMM assets
const origAssets = config.sniperAssets;
config.sniperAssets = [...new Set([...origAssets, ...CMM_ASSETS])];
startSniperDetector(handleNewMarket);

// Status logging every 60 seconds
statusTimer = setInterval(logStatus, 60_000);
logStatus();

// Longer crypto timeframes (1H, 4H, daily) — enabled via CMM_TIMEFRAMES env
const extraTFs = (process.env.CMM_TIMEFRAMES || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
if (extraTFs.length > 0) {
    startTimeframeDetector(extraTFs, CMM_ASSETS, handleNewMarket);
    logger.info(`CMM: extra timeframes enabled: ${extraTFs.join(', ')}`);
}

logger.info('CMM: waiting for markets...');
