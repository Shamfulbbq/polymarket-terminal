/**
 * feeSchedule.js — Shared fee computation for all Polymarket bots.
 *
 * Fee formula: fee_shares = shares × C × (p × (1 − p))^exponent
 *
 * Reads fee parameters from data/feeSchedule.json (cached at import time).
 * Falls back to hardcoded defaults if file is missing or malformed.
 *
 * Usage:
 *   import { computeFee, getRebateRate } from './feeSchedule.js';
 *   const fee = computeFee(shares, price, 'crypto');
 *   const rebate = fee * getRebateRate('crypto');
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEDULE_PATH = path.join(__dirname, '..', '..', 'data', 'feeSchedule.json');
const STALENESS_DAYS = 30;

// ── Hardcoded defaults (match data/feeSchedule.json) ─────────────────────────

const DEFAULTS = {
    crypto:      { C: 0.288, exponent: 2,   rebateRate: 0.20 },
    crypto_15m:  { C: 0.288, exponent: 2,   rebateRate: 0.20 },
    weather:     { C: 0.16,  exponent: 2,   rebateRate: 0.25 },
    sports:      { C: 0.03,  exponent: 0.5, rebateRate: 0.25 },
    politics:    { C: 0.16,  exponent: 2,   rebateRate: 0.25 },
    finance:     { C: 0.16,  exponent: 2,   rebateRate: 0.25 },
    tech:        { C: 0.16,  exponent: 2,   rebateRate: 0.25 },
    mentions:    { C: 0.24,  exponent: 2,   rebateRate: 0.25 },
    culture:     { C: 0.16,  exponent: 2,   rebateRate: 0.25 },
    economics:   { C: 0.24,  exponent: 2,   rebateRate: 0.25 },
    geopolitics: { C: 0.00,  exponent: 2,   rebateRate: 0.00 },
};

// ── Load schedule (once at import) ───────────────────────────────────────────

let _schedule = null;
let _lastUpdated = null;

function loadSchedule() {
    try {
        const raw = fs.readFileSync(SCHEDULE_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && parsed.categories) {
            _schedule = parsed.categories;
            _lastUpdated = parsed.lastUpdated || null;
            return;
        }
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.warn(`[feeSchedule] Failed to parse ${SCHEDULE_PATH}: ${err.message} — using defaults`);
        }
    }
    _schedule = DEFAULTS;
    _lastUpdated = null;
}

loadSchedule();

// ── Staleness check ──────────────────────────────────────────────────────────

export function checkStaleness() {
    if (!_lastUpdated) {
        console.warn('[feeSchedule] No lastUpdated field — fee schedule may be stale. Check Polymarket docs for changes.');
        return true;
    }
    const updated = new Date(_lastUpdated);
    const now = new Date();
    const daysSince = (now - updated) / (1000 * 60 * 60 * 24);
    if (daysSince > STALENESS_DAYS) {
        console.warn(`[feeSchedule] Fee schedule may be stale — last updated ${_lastUpdated} (${Math.floor(daysSince)} days ago). Check Polymarket docs for changes.`);
        return true;
    }
    return false;
}

// ── Fee computation ──────────────────────────────────────────────────────────

/**
 * Compute fee in shares for a given trade.
 * @param {number} shares   - number of shares
 * @param {number} price    - market price (0–1)
 * @param {string} category - fee category (e.g. 'crypto', 'weather', 'sports')
 * @returns {number} fee in shares
 */
export function computeFee(shares, price, category) {
    const params = _schedule[category] || _schedule['crypto'] || DEFAULTS['crypto'];
    return shares * params.C * Math.pow(price * (1 - price), params.exponent);
}

/**
 * Compute fee as a fraction of price (useful for edge calculations).
 * Returns the fee rate per share at a given price level.
 * @param {number} price    - market price (0–1)
 * @param {string} category - fee category
 * @returns {number} fee per share in price units
 */
export function computeFeeRate(price, category) {
    const params = _schedule[category] || _schedule['crypto'] || DEFAULTS['crypto'];
    return params.C * Math.pow(price * (1 - price), params.exponent);
}

/**
 * Get maker rebate rate for a category.
 * @param {string} category
 * @returns {number} rebate multiplier (e.g. 0.20 = 20%)
 */
export function getRebateRate(category) {
    const params = _schedule[category] || _schedule['crypto'] || DEFAULTS['crypto'];
    return params.rebateRate || 0;
}

/**
 * Get the loaded schedule (for testing/inspection).
 * @returns {object} the categories map
 */
export function getSchedule() {
    return _schedule;
}
