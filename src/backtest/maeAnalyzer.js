import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ALL_SIGNALS } from './signals.js';
import { sliceWindows } from './backtester.js';
import config from '../config/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(__dirname, '..', '..', 'data', 'backtest', 'btc_1m_klines.json');

async function runMaeAnalysis() {
    console.log('Loading 2 years of cached klines for MAE (Maximum Adverse Excursion) analysis...');
    const klines = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    const windows = sliceWindows(klines);
    
    const signalFn = ALL_SIGNALS['momentum'];
    const signalMinutes = 10;
    
    let wins = [];
    let losses = [];
    
    for (const w of windows) {
        const signalCandles = w.slice(0, signalMinutes);
        const { direction } = signalFn(signalCandles, { threshold: 0 }); // default momentum threshold
        
        if (!direction) continue;
        
        const outcomePriceOpen = w[0].open;
        const outcomePriceClose = w[14].close;
        const outcome = outcomePriceClose >= outcomePriceOpen ? 'UP' : 'DOWN';
        const won = direction === outcome;
        
        const entryPrice = signalCandles[9].close;
        const remainingCandles = w.slice(10);
        
        let maxAdverseMove = 0;
        
        for (const c of remainingCandles) {
            if (direction === 'UP') {
                // Adverse for UP is price dropping below entry
                const drop = ((entryPrice - c.low) / entryPrice) * 100;
                if (drop > maxAdverseMove) maxAdverseMove = drop;
            } else {
                // Adverse for DOWN is price rising above entry
                const rise = ((c.high - entryPrice) / entryPrice) * 100;
                if (rise > maxAdverseMove) maxAdverseMove = rise;
            }
        }
        
        if (won) {
            wins.push(maxAdverseMove);
        } else {
            losses.push(maxAdverseMove);
        }
    }
    
    console.log(`Total Trades Analyzed: ${wins.length + losses.length}`);
    console.log(`Wins: ${wins.length} | Losses: ${losses.length}`);
    console.log('--------------------------------------------------------------------------------');
    console.log('Stop-loss optimization based on 730 days of data at $0.55 Polymarket entry:');
    console.log('--------------------------------------------------------------------------------');
    console.log('BTC Price | Wins Falsely | Losses Successfully | Net Polymarket EV Impact');
    console.log('Adverse % | Stopped Out  | Escaped (Saved)     | (Assumes stop-loss exits at $0.20)');
    console.log('--------------------------------------------------------------------------------');
    
    // Evaluate stop-loss thresholds from 0.05% BTC drop up to 0.40% BTC drop
    const entryCost = 0.55;
    const stopLossSellValue = 0.20; // If we stop out, we sell the share back to the book for roughly $0.20
    const feeShares = 0.25 * Math.pow(0.55 * 0.45, 2); // 0.0153
    const netWinProfit = ((1 - feeShares) * 1.0) - entryCost; // ~0.4347
    
    const thresholds = [0.03, 0.05, 0.08, 0.10, 0.12, 0.15, 0.20, 0.25, 0.30, 0.40];
    
    for (const t of thresholds) {
        let falseStops = 0;
        for (const m of wins) {
            if (m >= t) falseStops++;
        }
        
        let savedLosses = 0;
        for (const m of losses) {
            if (m >= t) savedLosses++;
        }
        
        // Every falsely stopped win costs us the expected win (+0.4347) AND turns it into a loss (0.20 - 0.55 = -0.35) -> net damage = 0.7847
        const damageFromFalseStops = falseStops * (netWinProfit + (entryCost - stopLossSellValue)); 
        
        // Every saved loss saves us from losing -0.55, and instead we only lose -0.35 -> net savings = +0.20
        const profitFromSavedLosses = savedLosses * stopLossSellValue;
        
        const totalEvImpact = profitFromSavedLosses - damageFromFalseStops;
        
        const sign = totalEvImpact > 0 ? '+' : '';
        console.log(`${t.toFixed(2).padEnd(5)}%    | ${falseStops.toString().padEnd(12)} | ${savedLosses.toString().padEnd(19)} | ${sign}$${totalEvImpact.toFixed(2)}`);
    }
}

runMaeAnalysis().catch(err => console.error(err));
