/**
 * backtester.js
 * Core backtest engine for the BTC 15-minute directional sniper.
 *
 * 1. Loads 1-minute klines
 * 2. Slices into 15-minute windows aligned to clock boundaries (:00, :15, :30, :45)
 * 3. For each window, computes signal from the first N minutes
 * 4. Compares prediction to actual outcome (close >= open → UP, else DOWN)
 * 5. Aggregates accuracy and simulated PnL at various entry prices
 */

import { ALL_SIGNALS } from './signals.js';

const WINDOW_MINUTES = 15;
const ENTRY_PRICES = [0.50, 0.52, 0.55, 0.58, 0.60];

/**
 * Slice klines into 15-minute windows aligned to :00/:15/:30/:45.
 * @param {Array} klines — 1-minute candle objects (must have .openTime)
 * @returns {Array<Array>} — array of windows, each containing 15 candles
 */
export function sliceWindows(klines) {
    const windows = [];
    let i = 0;

    while (i < klines.length) {
        const candle = klines[i];
        const date = new Date(candle.openTime);
        const minute = date.getUTCMinutes();

        // Align to 15-minute boundary
        if (minute % WINDOW_MINUTES !== 0) {
            i++;
            continue;
        }

        // Collect the next 15 candles
        const window = klines.slice(i, i + WINDOW_MINUTES);
        if (window.length === WINDOW_MINUTES) {
            windows.push(window);
        }
        i += WINDOW_MINUTES;
    }

    return windows;
}

/**
 * Determine the actual outcome of a 15-minute window.
 * Matches Polymarket's Chainlink oracle logic: close >= open → UP wins.
 */
function getOutcome(window) {
    const openPrice = window[0].open;
    const closePrice = window[window.length - 1].close;
    return closePrice >= openPrice ? 'UP' : 'DOWN';
}

/**
 * Run a single signal across all windows and compute stats.
 *
 * @param {string} signalName
 * @param {Function} signalFn
 * @param {Array<Array>} windows — 15-minute windows
 * @param {number} signalMinutes — how many minutes of each window the signal reads
 * @param {Object} signalOpts — options passed to the signal function
 * @returns {Object} — { signalName, trades, wins, losses, skipped, accuracy, pnlByEntry, maxDrawdown }
 */
function runSignal(signalName, signalFn, windows, signalMinutes, signalOpts = {}) {
    let trades = 0;
    let wins = 0;
    let losses = 0;
    let skipped = 0;

    const pnlByEntry = {};
    const drawdownByEntry = {};
    for (const ep of ENTRY_PRICES) {
        pnlByEntry[ep] = 0;
        drawdownByEntry[ep] = { peak: 0, maxDrawdown: 0 };
    }

    for (const window of windows) {
        const signalCandles = window.slice(0, signalMinutes);
        const { direction } = signalFn(signalCandles, signalOpts);

        if (!direction) {
            skipped++;
            continue;
        }

        const outcome = getOutcome(window);
        const won = direction === outcome;
        trades++;
        if (won) wins++;
        else losses++;

        for (const ep of ENTRY_PRICES) {
            const tradePnl = won ? (1.0 - ep) : -ep;
            pnlByEntry[ep] += tradePnl;

            const dd = drawdownByEntry[ep];
            if (pnlByEntry[ep] > dd.peak) dd.peak = pnlByEntry[ep];
            const currentDD = dd.peak - pnlByEntry[ep];
            if (currentDD > dd.maxDrawdown) dd.maxDrawdown = currentDD;
        }
    }

    const accuracy = trades > 0 ? (wins / trades) * 100 : 0;

    const maxDrawdown = {};
    for (const ep of ENTRY_PRICES) {
        maxDrawdown[ep] = drawdownByEntry[ep].maxDrawdown;
    }

    return {
        signalName,
        trades,
        wins,
        losses,
        skipped,
        accuracy,
        pnlByEntry,
        maxDrawdown,
    };
}

/**
 * Run the full backtest: all signals across all windows, at multiple signal-minute settings.
 *
 * @param {Array} klines — 1-minute candles
 * @param {Object} opts — { signalMinutes: [1,3,5,10], signals: ['momentum', ...] }
 * @returns {Object} — { windows, results: [{ signalMinutes, signalName, ... }] }
 */
export function runBacktest(klines, opts = {}) {
    const signalMinutesList = opts.signalMinutes || [3];
    const signalNames = opts.signals || Object.keys(ALL_SIGNALS);

    const windows = sliceWindows(klines);

    // Baseline: how often UP vs DOWN wins
    let upCount = 0;
    let downCount = 0;
    for (const w of windows) {
        const outcome = getOutcome(w);
        if (outcome === 'UP') upCount++;
        else downCount++;
    }

    const results = [];

    for (const sm of signalMinutesList) {
        for (const name of signalNames) {
            const fn = ALL_SIGNALS[name];
            if (!fn) continue;

            const result = runSignal(name, fn, windows, sm);
            results.push({ signalMinutes: sm, ...result });
        }
    }

    return {
        totalWindows: windows.length,
        upWindows: upCount,
        downWindows: downCount,
        baseRate: ((Math.max(upCount, downCount) / windows.length) * 100).toFixed(1),
        results,
        entryPrices: ENTRY_PRICES,
    };
}
