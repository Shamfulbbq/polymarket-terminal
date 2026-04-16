/**
 * balanceLedger.js
 * Logs on-chain USDC.e balance snapshots at key moments for accurate PnL tracking.
 *
 * File: data/balance_ledger.jsonl
 * Each line: { ts, balance, event, details }
 *
 * Events:
 *   session_start    — bot startup
 *   session_end      — bot shutdown
 *   order_placed     — after sniper order submitted
 *   redeem_success   — after successful on-chain redeem
 *   redeem_failed    — after a failed redeem attempt
 *   periodic         — scheduled snapshot (every ~5 min)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const LEDGER_FILE = 'balance_ledger.jsonl';

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function appendJsonl(obj) {
    ensureDataDir();
    const filePath = path.join(DATA_DIR, LEDGER_FILE);
    try {
        fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf-8');
    } catch (err) {
        console.error(`balanceLedger: write failed — ${err.message}`);
    }
}

function readJsonl() {
    const filePath = path.join(DATA_DIR, LEDGER_FILE);
    if (!fs.existsSync(filePath)) return [];
    return fs
        .readFileSync(filePath, 'utf-8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
}

let _getBalance = null;

/**
 * Must be called once after client init so the ledger can read on-chain balance.
 */
export function initBalanceLedger(getUsdcBalanceFn) {
    _getBalance = getUsdcBalanceFn;
}

async function fetchBalance() {
    if (!_getBalance) return null;
    try {
        return await _getBalance();
    } catch {
        return null;
    }
}

/**
 * Log a balance snapshot.
 * @param {'session_start'|'session_end'|'order_placed'|'redeem_success'|'redeem_failed'|'periodic'} event
 * @param {Object} [details] — optional context (conditionId, orderId, asset, etc.)
 */
export async function logBalance(event, details = {}) {
    const balance = await fetchBalance();
    if (balance == null) return;
    appendJsonl({
        ts: new Date().toISOString(),
        balance: Math.round(balance * 1e6) / 1e6,
        event,
        details,
    });
}

/**
 * Compute PnL from the balance ledger.
 * Returns: { sessionStartBalance, currentBalance, sessionPnl, entries }
 */
export function getBalancePnl() {
    const entries = readJsonl();
    if (entries.length === 0) return null;

    const sessionStarts = entries.filter((e) => e.event === 'session_start');
    const startEntry = sessionStarts.length > 0 ? sessionStarts[sessionStarts.length - 1] : entries[0];

    const latest = entries[entries.length - 1];

    return {
        sessionStartBalance: startEntry.balance,
        sessionStartTs: startEntry.ts,
        currentBalance: latest.balance,
        currentTs: latest.ts,
        sessionPnl: Math.round((latest.balance - startEntry.balance) * 1e6) / 1e6,
        totalEntries: entries.length,
    };
}

/**
 * Compute a daily PnL breakdown from the ledger.
 * Returns array of { date, openBalance, closeBalance, pnl }.
 */
export function getDailyPnl() {
    const entries = readJsonl();
    if (entries.length === 0) return [];

    const byDay = new Map();
    for (const e of entries) {
        const day = e.ts.slice(0, 10);
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day).push(e);
    }

    const days = [];
    for (const [date, dayEntries] of byDay) {
        const open = dayEntries[0].balance;
        const close = dayEntries[dayEntries.length - 1].balance;
        days.push({
            date,
            openBalance: open,
            closeBalance: close,
            pnl: Math.round((close - open) * 1e6) / 1e6,
        });
    }
    return days;
}
