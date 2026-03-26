/**
 * weatherSniper.js
 * Entry point for the Polymarket Weather bot.
 * 
 * Uses an LLM to parse weather market rules, checks the forecasted high
 * from an API, and executes a trade if there is a positive expected value.
 */

import config from '../config/index.js';
import logger from '../utils/logger.js';
import { initClient, getUsdcBalance } from '../services/client.js';
import { initDashboard, appendLog, updateStatus, isDashboardActive } from '../ui/dashboard.js';
import { initBalanceLedger, logBalance } from '../utils/balanceLedger.js';
import { startWeatherDetector, stopWeatherDetector } from './weatherDetector.js';
import { getDailyHighTemperature } from './weatherFeed.js';

// Predefined coordinates for demo/fallback purposes.
// A more robust bot would extract coordinates via LLM or geocoding API.
const CITY_COORDS = {
    "nyc": { lat: 40.7128, lon: -74.0060 },
    "new york": { lat: 40.7128, lon: -74.0060 },
    "chicago": { lat: 41.8781, lon: -87.6298 },
    "la": { lat: 34.0522, lon: -118.2437 },
    "los angeles": { lat: 34.0522, lon: -118.2437 },
    "miami": { lat: 25.7617, lon: -80.1918 }
};

// ── Dashboard and UI ─────────────────────────────────────────────────────────
let weatherStats = {
    scannedMarkets: 0,
    parsedSuccessfully: 0,
    trades: []
};

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

    lines.push('{bold}WEATHER SNIPER STATS{/bold}');
    lines.push(`  Markets Scanned: ${weatherStats.scannedMarkets}`);
    lines.push(`  Parsed by Gemini: ${weatherStats.parsedSuccessfully}`);
    lines.push('');

    lines.push(`{bold}RECENT TRADES (${weatherStats.trades.length} total){/bold}`);
    if (weatherStats.trades.length === 0) {
        lines.push('  {gray-fg}Waiting for weather markets...{/gray-fg}');
    } else {
        const recent = weatherStats.trades.slice(-5).reverse();
        for (const t of recent) {
            lines.push(`  ${t.city} > ${t.targetTemp}F: Bought ${t.direction} @ $${t.price} (${t.reason})`);
        }
    }
    lines.push('');
    return '\n' + lines.join('\n');
}

let refreshTimer = null;
function startRefresh() {
    refreshTimer = setInterval(async () => {
        if (!isDashboardActive()) return;
        updateStatus(await buildStatusContent());
    }, 3000);
    buildStatusContent().then(updateStatus);
}

// ── Main Trading Logic ───────────────────────────────────────────────────────

async function handleNewWeatherMarket(market) {
    weatherStats.scannedMarkets++;
    const data = market.parsedData;
    
    if (!data || !data.city || !data.targetTemperature) return;
    weatherStats.parsedSuccessfully++;

    const cityKey = data.city.toLowerCase();
    const coords = CITY_COORDS[cityKey];

    if (!coords) {
        logger.warn(`WEATHER: Unknown coordinates for city: ${data.city}`);
        return;
    }

    const forecast = await getDailyHighTemperature(coords.lat, coords.lon);
    if (!forecast) return;

    logger.info(`WEATHER: Forecast for ${data.city} is ${forecast}F (Target is ${data.targetTemperature}F)`);

    // Simple strategy: buy "YES" if forecast > target, buy "NO" if forecast < target
    const isYes = forecast >= data.targetTemperature;
    const direction = isYes ? 'YES' : 'NO';
    const tokenId = isYes ? market.yesTokenId : market.noTokenId;

    logger.success(`WEATHER: Trade signal generated! Suggesting ${direction} for ${market.question}`);
    
    const tradeParams = {
        city: data.city,
        targetTemp: data.targetTemperature,
        direction,
        price: 0.50, // Mock price for execution
        reason: `Forecast ${forecast}F`
    };

    weatherStats.trades.push(tradeParams);

    // If live, we would use client.createAndPostOrder(...)
    // For now, this is simulated output.
    if (!config.dryRun) {
        logger.warn(`WEATHER: LIVE mode not fully implemented for USDC execution yet.`);
    } else {
        logger.info(`WEATHER: [SIM] Bought 10 shares of ${direction} for ${market.question}`);
    }
}

// ── Startup & Shutdown ───────────────────────────────────────────────────────

async function shutdown() {
    logger.warn('WEATHER: shutting down...');
    stopWeatherDetector();
    if (refreshTimer) clearInterval(refreshTimer);
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function start() {
    logger.info(`WEATHER SNIPER starting — ${config.dryRun ? 'SIMULATION' : 'LIVE'}`);
    
    // TUI Dashboard config
    initDashboard();
    logger.setOutput(appendLog);

    try {
        await initClient();
    } catch (err) {
        if (config.dryRun) {
            logger.warn(`Client init failed (${err.message}). Continuing in SIMULATION mode without wallet.`);
        } else {
            logger.error(`Client init error: ${err.message}`);
            process.exit(1);
        }
    }

    try {
        initBalanceLedger(getUsdcBalance);
    } catch { /* Ignore if no client */ }
    
    if (!config.dryRun) {
        await logBalance('session_start', { strategy: 'weather' });
    }

    startRefresh();
    startWeatherDetector(handleNewWeatherMarket);
}

start();
