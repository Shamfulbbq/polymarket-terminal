
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import { getPolygonProvider } from './client.js';
import { ethers } from 'ethers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ORDERS_LOG = path.join(process.cwd(), 'data/directional_orders.jsonl');
const AUDIT_CSV = path.join(process.cwd(), 'data/directional_audit.csv');

const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const CTF_ABI = [
    'function payoutNumerators(bytes32 conditionId, uint256 outcomeIndex) view returns (uint256)',
    'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
];

/**
 * Check if a market has been resolved via Polygon Smart Contract
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
 * Main Resolver Task: rebuilding the audit CSV
 */
export async function runDirectionalResolver() {
    if (!fs.existsSync(ORDERS_LOG)) return;

    const lines = fs.readFileSync(ORDERS_LOG, 'utf8').split('\n').filter(Boolean);
    const auditRows = [];
    const allFeatureKeys = new Set();

    logger.info(`DIRECTIONAL: Processing audit report for ${lines.length} trades...`);

    for (const line of lines) {
        try {
            const order = JSON.parse(line);
            
            // 1. Get fundamental columns
            const row = {
                Market: order.marketId || `${order.asset}_${order.orderTs || '?' }`,
                'ENTER?': order.entered || 0,
                RESULTS: '', // Pending
                PNL: 0,
                CONFIDENT: order.confidence ? Math.round(order.confidence * 100) / 100 : 0,
                RESOLUTION: '', // Pending
                'OUR PREDICTION': order.direction || ''
            };

            // 2. Load ML features
            if (order.features) {
                Object.keys(order.features).forEach(k => {
                    row[k] = order.features[k];
                    allFeatureKeys.add(k);
                });
            }

            // 3. Resolve market if not already resolved
            const resolvedDir = await getMarketResolution(order.conditionId);
            if (resolvedDir) {
                row.RESOLUTION = resolvedDir;
                const isCorrect = row['OUR PREDICTION'] === resolvedDir;
                
                if (row['ENTER?'] === 1) {
                    row.RESULTS = isCorrect ? 'WIN' : 'LOSS';
                    row.PNL = isCorrect ? (order.netPayoutIfWin - order.cost) : -order.cost;
                    row.PNL = Math.round(row.PNL * 100) / 100;
                } else {
                    // Missed trade analysis
                    row.RESULTS = isCorrect ? 'MISSED_WIN' : 'AVOIDED_LOSS';
                    row.PNL = 0; // Did not trade
                }
            } else {
                row.RESOLUTION = 'PENDING';
                row.RESULTS = 'PENDING';
            }

            auditRows.push(row);
        } catch (err) {
            // Skip malformed lines
        }
    }

    if (auditRows.length === 0) return;

    // 4. Generate CSV String
    const baseHeaders = ['Market', 'ENTER?', 'RESULTS', 'PNL', 'CONFIDENT', 'RESOLUTION', 'OUR PREDICTION'];
    const featureHeaders = Array.from(allFeatureKeys).sort();
    const finalHeaders = [...baseHeaders, ...featureHeaders];

    const csvLines = [];
    csvLines.push(finalHeaders.join(','));

    for (const row of auditRows) {
        const lineValues = finalHeaders.map(h => {
            let val = row[h];
            if (val === undefined || val === null) return '';
            if (typeof val === 'string' && val.includes(',')) return `"${val}"`;
            return val;
        });
        csvLines.push(lineValues.join(','));
    }

    try {
        fs.writeFileSync(AUDIT_CSV, csvLines.join('\n'), 'utf-8');
        logger.info(`DIRECTIONAL: Audit report updated -> data/directional_audit.csv (${auditRows.length} rows)`);
    } catch (err) {
        logger.error(`DIRECTIONAL: Failed to write audit CSV: ${err.message}`);
    }
}
