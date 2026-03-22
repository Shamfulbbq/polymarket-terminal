/**
 * report.js
 * Format and print backtest results to stdout.
 */

function pad(str, len, align = 'right') {
    str = String(str);
    if (align === 'right') return str.padStart(len);
    return str.padEnd(len);
}

function fmtPnl(value) {
    const sign = value >= 0 ? '+' : '';
    return `${sign}$${value.toFixed(2)}`;
}

/**
 * Print a full backtest report.
 * @param {Object} backtest — output from runBacktest()
 * @param {Object} opts — { days, signalMinutes }
 */
export function printReport(backtest, opts = {}) {
    const { totalWindows, upWindows, downWindows, baseRate, results, entryPrices } = backtest;

    const days = opts.days || '?';
    const endDate = new Date().toISOString().slice(0, 10);
    const startDate = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

    console.log('');
    console.log('='.repeat(90));
    console.log('  BTC 15-Min Directional Sniper Backtest');
    console.log('='.repeat(90));
    console.log(`  Period     : ${startDate} to ${endDate} (${days} days)`);
    console.log(`  Windows    : ${totalWindows} (UP: ${upWindows}, DOWN: ${downWindows})`);
    console.log(`  Base rate  : ${baseRate}% (always picking the majority side)`);
    console.log('');

    // Group results by signalMinutes
    const byMinutes = new Map();
    for (const r of results) {
        if (!byMinutes.has(r.signalMinutes)) byMinutes.set(r.signalMinutes, []);
        byMinutes.get(r.signalMinutes).push(r);
    }

    for (const [sm, smResults] of byMinutes) {
        console.log(`--- Signal window: first ${sm} minute(s) of each 15-min market ---`);
        console.log('');

        // Header
        const epHeaders = entryPrices.map((ep) => pad(`PnL@${(ep * 100).toFixed(0)}c`, 10));
        const ddHeaders = entryPrices.map((ep) => pad(`DD@${(ep * 100).toFixed(0)}c`, 9));

        console.log(
            pad('Signal', 22, 'left') +
            pad('Trades', 8) +
            pad('Wins', 7) +
            pad('Losses', 8) +
            pad('Skip', 7) +
            pad('Acc%', 8) +
            epHeaders.join('')
        );
        console.log('-'.repeat(22 + 8 + 7 + 8 + 7 + 8 + epHeaders.length * 10));

        for (const r of smResults) {
            const epCols = entryPrices.map((ep) => pad(fmtPnl(r.pnlByEntry[ep]), 10));

            console.log(
                pad(r.signalName, 22, 'left') +
                pad(r.trades, 8) +
                pad(r.wins, 7) +
                pad(r.losses, 8) +
                pad(r.skipped, 7) +
                pad(r.accuracy.toFixed(1) + '%', 8) +
                epCols.join('')
            );
        }

        // Max drawdown row
        console.log('');
        console.log('Max drawdown per signal:');
        for (const r of smResults) {
            const ddCols = entryPrices.map((ep) => pad(`$${r.maxDrawdown[ep].toFixed(2)}`, 10));
            console.log(
                pad(r.signalName, 22, 'left') + ' '.repeat(38) + ddCols.join('')
            );
        }
        console.log('');
    }

    // Recommendation
    const best = findBestSignal(results, entryPrices);
    if (best) {
        console.log('='.repeat(90));
        console.log(`  RECOMMENDATION: ${best.signalName} (${best.signalMinutes}min window) at $${best.entryPrice.toFixed(2)} entry`);
        console.log(`  Accuracy: ${best.accuracy.toFixed(1)}% | PnL: ${fmtPnl(best.pnl)} over ${days} days | ${best.trades} trades`);
        console.log(`  PnL/trade: ${fmtPnl(best.pnlPerTrade)} | Max drawdown: $${best.maxDrawdown.toFixed(2)}`);

        const breakEven = best.entryPrice / 1.0;
        console.log(`  Break-even accuracy needed at $${best.entryPrice.toFixed(2)}: ${(breakEven * 100).toFixed(1)}%`);
        const edge = best.accuracy - breakEven * 100;
        console.log(`  Edge over break-even: ${edge >= 0 ? '+' : ''}${edge.toFixed(1)} percentage points`);
        console.log('='.repeat(90));
    } else {
        console.log('='.repeat(90));
        console.log('  NO PROFITABLE SIGNAL FOUND');
        console.log('  None of the tested signals beat break-even at any entry price.');
        console.log('='.repeat(90));
    }

    console.log('');
}

function findBestSignal(results, entryPrices) {
    let best = null;

    for (const r of results) {
        if (r.trades < 10) continue;

        for (const ep of entryPrices) {
            const pnl = r.pnlByEntry[ep];
            const pnlPerTrade = pnl / r.trades;

            if (pnl > 0 && (!best || pnl > best.pnl)) {
                best = {
                    signalName: r.signalName,
                    signalMinutes: r.signalMinutes,
                    entryPrice: ep,
                    accuracy: r.accuracy,
                    trades: r.trades,
                    pnl,
                    pnlPerTrade,
                    maxDrawdown: r.maxDrawdown[ep],
                };
            }
        }
    }

    return best;
}
