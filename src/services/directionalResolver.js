
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import { getPolygonProvider } from './client.js';
import { ethers } from 'ethers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ORDERS_LOG = path.join(process.cwd(), 'data/directional_orders.jsonl');
const RESOLUTIONS_LOG = path.join(process.cwd(), 'data/directional_resolutions.jsonl');

const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const CTF_ABI = [
    'function payoutNumerators(bytes32 conditionId, uint256 outcomeIndex) view returns (uint256)',
    'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
];

// Cache to avoid scanning the whole file every time
let lastProcessedTs = 0;
const processedConditions = new Set();

/**
 * Load existing resolutions into memory
 */
function loadResolved() {
    if (!fs.existsSync(RESOLUTIONS_LOG)) return;
    const lines = fs.readFileSync(RESOLUTIONS_LOG, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
        try {
            const res = JSON.parse(line);
            processedConditions.add(res.conditionId);
        } catch {}
    }
}

/**
 * Check if a market has been resolved via Gamma API
 */
async function getMarketResolution(conditionId) {
    try {
        const provider = await getPolygonProvider();
        const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, provider);

        const denominator = await ctf.payoutDenominator(conditionId);
        if (denominator.isZero()) return null;

        const yesNumerator = await ctf.payoutNumerators(conditionId, 0);
        const noNumerator = await ctf.payoutNumerators(conditionId, 1);

        const yesRatio = yesNumerator.toNumber() / denominator.toNumber();
        const noRatio = noNumerator.toNumber() / denominator.toNumber();

        if (yesRatio > 0.9) return 'UP';
        if (noRatio > 0.9) return 'DOWN';
        return 'OTHER';
    } catch {
        return null;
    }
}

/**
 * Run the resolution check loop
 */
export async function runDirectionalResolver() {
    loadResolved();

    if (!fs.existsSync(ORDERS_LOG)) return;

    const lines = fs.readFileSync(ORDERS_LOG, 'utf8').split('\n').filter(Boolean);
    const pending = [];

    for (const line of lines) {
        try {
            const order = JSON.parse(line);
            if (!order.direction || processedConditions.has(order.conditionId)) continue;
            
            // Only look at markets older than 20 mins (should be resolved by then)
            const ageMs = Date.now() - new Date(order.ts).getTime();
            if (ageMs < 20 * 60 * 1000) continue;

            pending.push(order);
        } catch {}
    }

    if (pending.length === 0) return;

    logger.info(`DIRECTIONAL: Checking resolution for ${pending.length} recent market(s)...`);

    for (const order of pending) {
        const resolvedDir = await getMarketResolution(order.conditionId);
        if (!resolvedDir) continue;

        const isCorrect = order.direction === resolvedDir;
        let outcome = '';

        if (order.status === 'placed') {
            outcome = isCorrect ? 'WIN' : 'LOSS';
        } else {
            outcome = isCorrect ? 'MISSED_WIN' : 'AVOIDED_LOSS';
        }

        const resEntry = {
            ts: new Date().toISOString(),
            marketTs: order.ts,
            conditionId: order.conditionId,
            asset: order.asset,
            signal: order.signal,
            prediction: order.direction,
            actual: resolvedDir,
            status: order.status,
            reason: order.reason || null,
            outcome,
            confidence: order.confidence
        };

        fs.appendFileSync(RESOLUTIONS_LOG, JSON.stringify(resEntry) + '\n');
        processedConditions.add(order.conditionId);

        const msg = `DIRECTIONAL: Resolution ${outcome} for ${order.asset} "${order.question?.slice(0, 30)}..." | Predict: ${order.direction} Actual: ${resolvedDir}`;
        if (outcome === 'WIN') logger.money(msg);
        else if (outcome === 'MISSED_WIN') logger.warn(msg);
        else if (outcome === 'AVOIDED_LOSS') logger.success(msg);
        else logger.error(msg);
    }
}
