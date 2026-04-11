/**
 * cryptoMM.js
 * Entry point for the Crypto Market Maker bot.
 * Posts two-sided quotes on Polymarket 5-minute BTC/ETH/SOL markets
 * to earn maker rebates + liquidity rewards.
 *
 * Run with: npm run cmm         (live)
 *           npm run cmm:paper   (paper trading with $1000 virtual balance)
 */

import config, { validateMMConfig } from './config/index.js';
import logger from './utils/logger.js';
import { initClientWithKeys } from './services/client.js';
import { startBinanceFeed, stopBinanceFeed, getBinanceFeedStatus } from './services/binanceFeed.js';
import { startSniperDetector, stopSniperDetector } from './services/sniperDetector.js';
import { startTimeframeDetector, stopTimeframeDetector } from './services/cryptoTimeframeDetector.js';
import { scheduleMarket, getMMStats, cancelAllOrders, isDailyLossHit, checkFills, CMM_ASSETS, loadSignalModels, saveState } from './services/cryptoMMExecutor.js';
import { sendCmmReport, sendHeartbeat, sendModelDegradationAlert, sendFeedStalenessAlert, ENABLED as TELEGRAM_ENABLED } from './services/telegram.js';
import { checkModelDegradation } from './services/cmmSignal.js';
import { checkAllFeedStaleness } from './services/binanceFeed.js';

// ── Validate ────────────────────────────────────────────────────────────────

validateMMConfig();

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
        `feed=${feedStatus} BTC=${priceStr}`
    );
}

// ── Graceful shutdown ───────────────────────────────────────────────────────

async function shutdown() {
    logger.warn('CMM: shutting down...');
    stopSniperDetector();
    stopTimeframeDetector();
    stopBinanceFeed();
    await cancelAllOrders();
    if (fillTimer) clearInterval(fillTimer);
    if (statusTimer) clearInterval(statusTimer);

    const stats = getMMStats();
    const dailyPnlStr = stats.dailyPnl >= 0 ? `+$${stats.dailyPnl.toFixed(2)}` : `-$${Math.abs(stats.dailyPnl).toFixed(2)}`;
    logger.info(`CMM: final stats — fills=${stats.fills} W=${stats.wins} L=${stats.losses} daily=${dailyPnlStr}`);
    saveState();

    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ── Start ───────────────────────────────────────────────────────────────────

const CMM_TIMEFRAMES = (process.env.CMM_TIMEFRAMES || '15m,4h').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const has5m = CMM_TIMEFRAMES.includes('5m');
const longTFs = CMM_TIMEFRAMES.filter(tf => tf !== '5m');

await loadSignalModels();

const mode = config.dryRun ? 'PAPER ($1000 virtual)' : 'LIVE';
logger.info(`CMM starting — ${mode}`);
logger.info(`Assets: ${CMM_ASSETS.join(', ').toUpperCase()} | Timeframes: ${CMM_TIMEFRAMES.join(', ')} | Spread: ${process.env.CMM_SPREAD || '0.04'} | Shares: ${process.env.CMM_SHARES || '20'} | Max daily loss: $${process.env.CMM_MAX_DAILY_LOSS || '50'}`);

// Cancel any stale open orders from previous sessions before posting new quotes
if (!config.dryRun) {
    try {
        const { getClient } = await import('./services/client.js');
        await getClient().cancelAll();
        logger.info('CMM: startup — stale orders cleared');
    } catch (err) {
        logger.warn(`CMM: startup cancelAll failed — ${err.message}`);
    }
}

// Start Binance feed for signal data
startBinanceFeed();

// 5-minute markets — only if '5m' is in CMM_TIMEFRAMES
// CMM_5M_ASSETS controls which assets run 5m (default: btc only)
if (has5m) {
    const assets5m = (process.env.CMM_5M_ASSETS || 'btc').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const origAssets = config.sniperAssets;
    config.sniperAssets = [...new Set([...origAssets, ...assets5m])];
    startSniperDetector(handleNewMarket);
    logger.info(`CMM: 5m detector started — assets: ${assets5m.join(', ').toUpperCase()}`);
}

// 1H+ markets
if (longTFs.length > 0) {
    startTimeframeDetector(longTFs, CMM_ASSETS, handleNewMarket);
    logger.info(`CMM: timeframe detector started — ${longTFs.join(', ')}`);
}

// Fill detection every 15 seconds — uses getTrades() for reliable fill tracking
const fillTimer = setInterval(async () => {
    try { await checkFills(); } catch (err) { logger.warn(`CMM: fill check error — ${err.message}`); }
}, 15_000);

// Status logging every 60 seconds
statusTimer = setInterval(logStatus, 60_000);
logStatus();

// Telegram: full report every 4h at 00/04/08/12/16/20 UTC
//           heartbeat (alive ping) every other hour — dead-man switch
const STATS_HOURS = new Set([0, 4, 8, 12, 16, 20]);
if (TELEGRAM_ENABLED) {
    const cmmMode = config.dryRun ? 'PAPER' : 'LIVE';

    function msUntilNextHour() {
        const now = new Date();
        const next = new Date(now);
        next.setUTCMinutes(0, 0, 0);
        next.setUTCHours(next.getUTCHours() + 1);
        return next.getTime() - now.getTime();
    }

    function scheduleNextHourlyTick() {
        setTimeout(async () => {
            const h = new Date().getUTCHours();
            const stats = getMMStats();
            if (STATS_HOURS.has(h)) {
                try { await sendCmmReport(stats, CMM_TIMEFRAMES); } catch {}
            } else {
                try { await sendHeartbeat(stats, cmmMode); } catch {}
            }

            // ML model degradation check (every hour)
            for (const asset of CMM_ASSETS) {
                const deg = checkModelDegradation(asset);
                if (deg.degraded) {
                    logger.warn(`CMM: ML model degraded for ${asset.toUpperCase()} — ${deg.reason}`);
                    try { await sendModelDegradationAlert(asset, deg.reason); } catch {}
                }
            }

            // Feed staleness check (every hour)
            const staleness = checkAllFeedStaleness();
            for (const [asset, result] of staleness) {
                if (result.stale) {
                    logger.warn(`CMM: feed stale for ${asset.toUpperCase()} — ${result.reason}`);
                    try { await sendFeedStalenessAlert(asset, result.staleDurationMs); } catch {}
                }
            }

            scheduleNextHourlyTick();
        }, msUntilNextHour());
    }

    scheduleNextHourlyTick();
    logger.info(`CMM: Telegram enabled — full report at 00/04/08/12/16/20 UTC, heartbeat every other hour`);
}

logger.info('CMM: waiting for markets...');
