/**
 * fetchKlines.js
 * Download BTCUSDT 1-minute klines from Binance REST API and cache locally.
 * Public endpoint — no API key required.
 *
 * Binance returns max 1000 candles per request, so we paginate.
 * Each candle: [openTime, open, high, low, close, volume, closeTime,
 *               quoteVolume, trades, takerBuyBaseVol, takerBuyQuoteVol, ignore]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '..', '..', 'data', 'backtest');
const CACHE_FILE = path.join(CACHE_DIR, 'btc_1m_klines.json');

const BINANCE_KLINES = 'https://api.binance.com/api/v3/klines';
const SYMBOL = 'BTCUSDT';
const INTERVAL = '1m';
const BATCH_SIZE = 1000;

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch 1-minute BTCUSDT klines from Binance for the given number of days.
 * Caches to disk; pass forceRefresh=true to re-download.
 *
 * @param {number} days — how many days of history to fetch
 * @param {boolean} forceRefresh — skip cache
 * @returns {Array<Object>} — array of candle objects
 */
export async function fetchKlines(days = 30, forceRefresh = false) {
    if (!forceRefresh && fs.existsSync(CACHE_FILE)) {
        const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
        const cacheDays = (cached.length * 60_000) / 86_400_000;
        if (cacheDays >= days * 0.9) {
            console.log(`Using cached klines: ${cached.length} candles (~${cacheDays.toFixed(1)} days)`);
            return cached;
        }
    }

    const endMs = Date.now();
    const startMs = endMs - days * 24 * 60 * 60 * 1000;
    const totalCandles = days * 24 * 60;
    const batches = Math.ceil(totalCandles / BATCH_SIZE);

    console.log(`Fetching ${totalCandles} candles (${days} days) from Binance in ${batches} batches...`);

    const allCandles = [];
    let cursor = startMs;

    for (let i = 0; i < batches; i++) {
        const url = `${BINANCE_KLINES}?symbol=${SYMBOL}&interval=${INTERVAL}&startTime=${cursor}&limit=${BATCH_SIZE}`;
        const resp = await fetch(url);

        if (!resp.ok) {
            const text = await resp.text();
            throw new Error(`Binance API error ${resp.status}: ${text}`);
        }

        const raw = await resp.json();
        if (raw.length === 0) break;

        for (const c of raw) {
            allCandles.push({
                openTime: c[0],
                open: parseFloat(c[1]),
                high: parseFloat(c[2]),
                low: parseFloat(c[3]),
                close: parseFloat(c[4]),
                volume: parseFloat(c[5]),
                closeTime: c[6],
                quoteVolume: parseFloat(c[7]),
                trades: c[8],
                takerBuyBaseVol: parseFloat(c[9]),
                takerBuyQuoteVol: parseFloat(c[10]),
            });
        }

        cursor = raw[raw.length - 1][6] + 1; // closeTime + 1ms
        if (cursor >= endMs) break;

        process.stdout.write(`  Batch ${i + 1}/${batches} — ${allCandles.length} candles\r`);
        await sleep(200); // respect rate limits
    }

    console.log(`\nFetched ${allCandles.length} candles total.`);

    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(allCandles), 'utf-8');
    console.log(`Cached to ${CACHE_FILE}`);

    return allCandles;
}
