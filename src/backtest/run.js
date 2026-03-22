/**
 * run.js
 * Entry point for the BTC 15-minute directional sniper backtester.
 *
 * Usage:
 *   node src/backtest/run.js
 *   node src/backtest/run.js --days 60 --signal-minutes 1,3,5,10
 *   node src/backtest/run.js --refresh   (force re-download klines)
 */

import { fetchKlines } from './fetchKlines.js';
import { runBacktest } from './backtester.js';
import { printReport } from './report.js';
import { ALL_SIGNALS } from './signals.js';

function parseArgs() {
    const args = process.argv.slice(2);
    const opts = {
        days: 30,
        signalMinutes: [1, 3, 5, 10],
        signals: Object.keys(ALL_SIGNALS),
        refresh: false,
    };

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--days':
                opts.days = parseInt(args[++i], 10) || 30;
                break;
            case '--signal-minutes':
                opts.signalMinutes = args[++i].split(',').map(Number).filter((n) => n > 0 && n < 15);
                break;
            case '--signals':
                opts.signals = args[++i].split(',').filter((s) => ALL_SIGNALS[s]);
                break;
            case '--refresh':
                opts.refresh = true;
                break;
            case '--help':
                console.log(`
BTC 15-Min Directional Sniper Backtester

Options:
  --days N              Days of history to test (default: 30)
  --signal-minutes N,N  Comma-separated signal windows to test (default: 1,3,5,10)
  --signals name,name   Comma-separated signals (default: all)
                        Available: ${Object.keys(ALL_SIGNALS).join(', ')}
  --refresh             Force re-download klines from Binance
  --help                Show this help
`);
                process.exit(0);
        }
    }

    return opts;
}

async function main() {
    const opts = parseArgs();

    console.log(`BTC 15-Min Directional Sniper Backtester`);
    console.log(`Days: ${opts.days} | Signal windows: ${opts.signalMinutes.join(', ')} min`);
    console.log(`Signals: ${opts.signals.join(', ')}`);
    console.log('');

    const klines = await fetchKlines(opts.days, opts.refresh);

    const result = runBacktest(klines, {
        signalMinutes: opts.signalMinutes,
        signals: opts.signals,
    });

    printReport(result, { days: opts.days });
}

main().catch((err) => {
    console.error('Backtest failed:', err.message);
    process.exit(1);
});
