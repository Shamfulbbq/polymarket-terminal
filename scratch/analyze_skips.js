
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = path.join(process.env.HOME, 'polymarket-terminal/data/directional_orders.jsonl');

async function getBinancePrice(symbol, timestamp) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=1m&startTime=${timestamp}&limit=1`;
    try {
        const resp = await fetch(url);
        const data = await resp.json();
        return data?.[0]?.[1] ? parseFloat(data[0][1]) : null;
    } catch { return null; }
}

async function analyze() {
    if (!fs.existsSync(LOG_FILE)) {
        console.log("Log file not found.");
        return;
    }

    const lines = fs.readFileSync(LOG_FILE, 'utf-8').split('\n').filter(Boolean);
    const skips = lines.map(l => JSON.parse(l)).filter(o => o.status === 'skipped' && o.direction).slice(-100);

    console.log(`Analyzing ${skips.length} skipped trades with a predicted direction...`);
    console.log('---------------------------------------------------------------------------------------------------');
    console.log('| Asset | Time (UTC)       | Signal    | Conf  | Predict | Reason            | P_Open   | P_Close  | Result |');
    console.log('---------------------------------------------------------------------------------------------------');

    let total = 0;
    let correct = 0;
    let lowConfCorrect = 0;
    let lowConfTotal = 0;
    let unfillableCorrect = 0;
    let unfillableTotal = 0;

    // Only analyze the last 20 for brief summary
    console.log('... processed all samples ...');

    for (const skip of skips) {
        const evalTime = new Date(skip.ts).getTime();
        const slotOpenTs = Math.floor(evalTime / (15 * 60 * 1000)) * (15 * 60 * 1000);
        const slotCloseTs = slotOpenTs + (15 * 60 * 1000);

        const openPrice = await getBinancePrice(skip.asset, slotOpenTs);
        const closePrice = await getBinancePrice(skip.asset, slotCloseTs);

        if (!openPrice || !closePrice) continue;

        const priceChange = closePrice - openPrice;
        const actualDir = priceChange > 0 ? 'UP' : 'DOWN';
        const isCorrect = skip.direction === actualDir;

        total++;
        if (isCorrect) correct++;

        if (skip.reason === 'low_confidence') {
            lowConfTotal++;
            if (isCorrect) lowConfCorrect++;
        } else if (skip.reason === 'orderbook_unfillable' || skip.reason === 'max_entry_price') {
            unfillableTotal++;
            if (isCorrect) unfillableCorrect++;
        }
    }

    console.log('---------------------------------------------------------------------------------------------------');
    console.log(`Total Samples: ${total}`);
    console.log(`Overall "Correct" Rate: ${((correct / total) * 100).toFixed(1)}%`);
    console.log(`Low Confidence Skip Accuracy: ${((lowConfCorrect / lowConfTotal) * 100).toFixed(1)}% (${lowConfCorrect}/${lowConfTotal})`);
    console.log(`Price Cap Skip Accuracy: ${((unfillableCorrect / unfillableTotal) * 100).toFixed(1)}% (${unfillableCorrect}/${unfillableTotal})`);
}

analyze();
