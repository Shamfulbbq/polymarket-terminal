/**
 * tailSweepExecutor.js
 * Monitors 5-minute markets near expiry. When one side's best bid exceeds
 * the configured threshold (e.g. $0.90) in the last N seconds, places an
 * aggressive BUY on the dominant side.
 *
 * Paper mode: logs what WOULD have been bought, then checks outcome after
 * resolution to track simulated PnL across multiple thresholds and sizes.
 */

import { Side, OrderType } from '@polymarket/clob-client';
import config from '../config/index.js';
import { submitOrderTimed, getUsdcBalance } from './client.js';
import { checkResolutionOnChain } from './ctf.js';
import { kellyShares } from '../utils/kelly.js';
import logger from '../utils/logger.js';
import { logBalance } from '../utils/balanceLedger.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'tailsweep_orders.jsonl');

function appendOrder(obj) {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    try {
        fs.appendFileSync(ORDERS_FILE, JSON.stringify(obj) + '\n', 'utf-8');
    } catch (err) {
        logger.error(`tailSweep: log write failed — ${err.message}`);
    }
}

// Polymarket fee: fee_shares = shares * 0.25 * (price * (1 - price))^2
function computeFeeShares(shares, price) {
    return shares * 0.25 * Math.pow(price * (1 - price), 2);
}

const SLOT_5M  = 5  * 60;
const SLOT_15M = 15 * 60;
const pendingTimers = new Map();
const trades = [];

// ── Rolling stats per asset (for Kelly sizing) ──────────────────────────────
const rollingStats = {}; // { btc: { wins: 0, total: 0 }, eth: { ... } }

function getStats(asset) {
    const key = asset.toLowerCase();
    if (!rollingStats[key]) rollingStats[key] = { wins: 0, total: 0 };
    return rollingStats[key];
}

export function getLiveStats() { return { ...rollingStats }; }

// ── Asset-specific config lookup ─────────────────────────────────────────────
function assetConfig(asset, key, fallback) {
    const overrides = config.tailSweepAssetOverrides || {};
    const o = overrides[asset.toLowerCase()];
    if (o && o[key] !== undefined) return o[key];
    return fallback;
}
const paperThresholds = [0.85, 0.88, 0.90, 0.92, 0.95];
const paperSizes = [5, 10];
const paperStats = {};

function initPaperStats() {
    for (const th of paperThresholds) {
        for (const sz of paperSizes) {
            const key = `${th}-${sz}`;
            if (!paperStats[key]) paperStats[key] = { trades: 0, wins: 0, pnl: 0 };
        }
    }
}
initPaperStats();

export function getTrades() { return [...trades]; }
export function getPendingCount() { return pendingTimers.size; }
export function getPaperStats() { return { ...paperStats }; }

async function fetchOrderbook(tokenId) {
    try {
        const resp = await fetch(`${config.clobHost}/book?token_id=${tokenId}`, {
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(5000),
        });
        if (!resp.ok) return null;
        const data = await resp.json();
        const bids = data.bids || [];
        const asks = data.asks || [];
        const bestBid = bids.length > 0 ? parseFloat(bids[bids.length - 1].price) : 0;
        const bestAsk = asks.length > 0 ? parseFloat(asks[asks.length - 1].price) : 1;
        const askLiquidity = asks.reduce((sum, a) => sum + parseFloat(a.size || 0), 0);
        const bidLiquidity = bids.reduce((sum, b) => sum + parseFloat(b.size || 0), 0);
        return { bestBid, bestAsk, askLiquidity, bidLiquidity, spread: Math.round((bestAsk - bestBid) * 10000) / 10000 };
    } catch { return null; }
}

/**
 * Called when a 5-minute market is detected.
 * Schedules an orderbook check N seconds before the market closes.
 */
export function scheduleTailSweep(market) {
    const slotDuration = market.slotDuration || SLOT_5M;
    const slotEnd = market.endTime
        ? new Date(market.endTime).getTime()
        : (market.slotTimestamp + slotDuration) * 1000;

    // Time-of-day filter
    if (config.tailSweepBlockedHours.length > 0) {
        const hourUtc = new Date().getUTCHours();
        if (config.tailSweepBlockedHours.includes(hourUtc)) {
            logger.info(`TAILSWEEP: skipping ${market.asset.toUpperCase()} — UTC hour ${hourUtc} is blocked`);
            return;
        }
    }

    const secsBefore = slotDuration === SLOT_15M ? config.tailSweep15mSecsBefore : config.tailSweepSecondsBefore;
    const checkAtMs = slotEnd - secsBefore * 1000;
    const delayMs = Math.max(0, checkAtMs - Date.now());
    const key = `${market.asset}-${market.slotTimestamp}`;

    if (pendingTimers.has(key)) return;
    if (delayMs <= 0) return; // already past the check time

    logger.info(
        `TAILSWEEP: ${market.asset.toUpperCase()} scheduled check ${config.tailSweepSecondsBefore}s before close (in ${Math.round(delayMs / 1000)}s)`
    );

    const timer = setTimeout(() => {
        pendingTimers.delete(key);
        executeSweep(market, slotEnd).catch(err =>
            logger.error(`TAILSWEEP: error — ${err.message}`)
        );
    }, delayMs);

    pendingTimers.set(key, timer);
}

async function executeSweep(market, slotEndMs) {
    const { asset, conditionId, question, yesTokenId, noTokenId, tickSize, negRisk } = market;
    const label = `${asset.toUpperCase()} ${(question || '').slice(0, 35)}`;

    // Fetch orderbook for both sides simultaneously
    const [bookUp, bookDown] = await Promise.all([
        fetchOrderbook(yesTokenId),
        fetchOrderbook(noTokenId),
    ]);

    if (!bookUp || !bookDown) {
        logger.warn(`TAILSWEEP: ${label} — orderbook unavailable, skipping`);
        return;
    }

    const upBid = bookUp.bestBid;
    const downBid = bookDown.bestBid;

    logger.info(
        `TAILSWEEP: ${label} | UP bid=$${upBid.toFixed(2)} ask=$${bookUp.bestAsk.toFixed(2)} liq=${bookUp.askLiquidity.toFixed(0)} | ` +
        `DOWN bid=$${downBid.toFixed(2)} ask=$${bookDown.bestAsk.toFixed(2)} liq=${bookDown.askLiquidity.toFixed(0)}`
    );

    // Determine dominant side
    let dominantSide, dominantBid, dominantAsk, dominantLiq, tokenId;
    if (upBid > downBid) {
        dominantSide = 'UP';
        dominantBid = upBid;
        dominantAsk = bookUp.bestAsk;
        dominantLiq = bookUp.askLiquidity;
        tokenId = yesTokenId;
    } else {
        dominantSide = 'DOWN';
        dominantBid = downBid;
        dominantAsk = bookDown.bestAsk;
        dominantLiq = bookDown.askLiquidity;
        tokenId = noTokenId;
    }

    // Paper mode: log simulated trades at ALL thresholds
    if (config.dryRun) {
        await paperTrade(market, dominantSide, dominantBid, dominantAsk, dominantLiq, slotEndMs);
        return;
    }

    // Live mode: asset-specific config
    const threshold   = assetConfig(asset, 'threshold', config.tailSweepThreshold);
    const maxPrice    = assetConfig(asset, 'maxPrice',  config.tailSweepMaxPrice);
    const minBidLiq   = assetConfig(asset, 'minBidLiq', config.tailSweepMinBidLiq);

    // Check threshold
    if (dominantBid < threshold) {
        logger.info(`TAILSWEEP: ${label} — ${dominantSide} bid $${dominantBid.toFixed(2)} below threshold $${threshold} — skipping`);
        logOrder(market, dominantSide, dominantBid, dominantAsk, dominantLiq, 'skipped', 'below_threshold');
        return;
    }

    // Ask-side liquidity check
    if (dominantLiq < config.tailSweepMinLiquidity) {
        logger.warn(`TAILSWEEP: ${label} — ${dominantSide} ask liquidity ${dominantLiq.toFixed(0)} < ${config.tailSweepMinLiquidity} min — skipping`);
        logOrder(market, dominantSide, dominantBid, dominantAsk, dominantLiq, 'skipped', 'low_liquidity');
        return;
    }

    // Bid-side depth filter
    const dominantBidLiq = dominantSide === 'UP' ? bookUp.bidLiquidity : bookDown.bidLiquidity;
    if (minBidLiq > 0 && dominantBidLiq < minBidLiq) {
        logger.info(`TAILSWEEP: ${label} — ${dominantSide} bid liq ${dominantBidLiq.toFixed(0)} < ${minBidLiq} min — skipping`);
        logOrder(market, dominantSide, dominantBid, dominantAsk, dominantLiq, 'skipped', 'low_bid_liquidity');
        return;
    }

    // Entry price ceiling
    if (maxPrice > 0 && dominantAsk > maxPrice) {
        logger.info(`TAILSWEEP: ${label} — ${dominantSide} ask $${dominantAsk.toFixed(2)} above max $${maxPrice} — skipping`);
        logOrder(market, dominantSide, dominantBid, dominantAsk, dominantLiq, 'skipped', 'above_price_ceiling');
        return;
    }

    // Position sizing: Kelly or flat
    const entryPrice = dominantAsk;
    const stats = getStats(asset);
    let shares;
    if (config.tailSweepKellyEnabled && stats.total >= config.tailSweepKellyMinTrades) {
        let balance = config.tailSweepShares * entryPrice; // fallback
        try { balance = await getUsdcBalance(); } catch { /* use fallback */ }
        shares = kellyShares({
            winRate:     stats.total > 0 ? stats.wins / stats.total : 0,
            entryPrice,
            balance,
            minShares:   1,
            maxShares:   config.tailSweepMaxShares,
            totalTrades: stats.total,
            minTrades:   config.tailSweepKellyMinTrades,
        });
        logger.info(`TAILSWEEP: Kelly → ${shares}sh (wr=${(stats.wins/stats.total*100).toFixed(0)}% n=${stats.total} bal=$${balance.toFixed(0)})`);
    } else {
        shares = assetConfig(asset, 'shares', config.tailSweepShares);
    }

    if (shares <= 0) {
        logger.info(`TAILSWEEP: ${label} — Kelly says 0 shares (no edge) — skipping`);
        logOrder(market, dominantSide, dominantBid, dominantAsk, dominantLiq, 'skipped', 'kelly_no_edge');
        return;
    }

    const cost = entryPrice * shares;
    const fee = computeFeeShares(shares, entryPrice);
    const netPayout = (shares - fee) * 1.0;

    // Balance check
    try {
        const balance = await getUsdcBalance();
        if (balance < cost) {
            logger.warn(`TAILSWEEP: insufficient balance $${balance.toFixed(2)} < $${cost.toFixed(2)} — skipping`);
            logOrder(market, dominantSide, dominantBid, dominantAsk, dominantLiq, 'skipped', 'insufficient_balance');
            return;
        }
    } catch { /* proceed */ }

    try {
        const { res, timing } = await submitOrderTimed(
            { tokenID: tokenId, side: Side.BUY, price: entryPrice, size: shares },
            { tickSize, negRisk },
            OrderType.GTC,
        );

        if (res?.success) {
            logger.money(
                `TAILSWEEP: BUY ${dominantSide} @ $${entryPrice.toFixed(2)} × ${shares}sh | ` +
                `cost $${cost.toFixed(2)} | profit if win $${(netPayout - cost).toFixed(2)} | order ${res.orderID}`
            );
            trades.push({
                asset: asset.toUpperCase(), side: dominantSide, price: entryPrice,
                shares, cost, fee: Math.round(fee * 10000) / 10000,
                netPayout: Math.round(netPayout * 100) / 100,
                orderId: res.orderID, ts: new Date().toISOString(),
            });
            logOrder(market, dominantSide, dominantBid, dominantAsk, dominantLiq, 'placed', null, res.orderID, entryPrice);
            logBalance('tailsweep_order', { side: dominantSide, orderId: res.orderID, cost }).catch(() => {});
            // Auto outcome tracking
            scheduleOutcomeCheck(market, dominantSide, entryPrice, shares, cost, fee);
        } else {
            const errMsg = res?.errorMsg || res?.message || 'unknown';
            logger.warn(`TAILSWEEP: order failed — ${errMsg}`);
            logOrder(market, dominantSide, dominantBid, dominantAsk, dominantLiq, 'failed', errMsg);
        }
    } catch (err) {
        logger.error(`TAILSWEEP: order error — ${err.message}`);
        logOrder(market, dominantSide, dominantBid, dominantAsk, dominantLiq, 'error', err.message);
    }
}

// ── Auto outcome tracking (live trades) ──────────────────────────────────────

function scheduleOutcomeCheck(market, side, entryPrice, shares, cost, feeShares) {
    const slotDuration = market.slotDuration || SLOT_5M;
    const slotEnd = market.endTime
        ? new Date(market.endTime).getTime()
        : (market.slotTimestamp + slotDuration) * 1000;
    const waitMs = Math.max(0, slotEnd - Date.now()) + 3 * 60_000; // wait until close + 3 min

    setTimeout(async () => {
        const label = `${market.asset.toUpperCase()} ${(market.question || '').slice(0, 30)}`;
        let outcome = null;

        // Try on-chain first (works from Ireland server), fall back to Gamma
        for (let attempt = 1; attempt <= 6; attempt++) {
            outcome = await checkResolutionOnChain(market.conditionId);
            if (!outcome) outcome = await checkOutcome(market);
            if (outcome) break;
            if (attempt < 6) await new Promise(r => setTimeout(r, 60_000));
        }

        if (!outcome) {
            logger.warn(`TAILSWEEP: outcome unknown for ${label} after 6 attempts`);
            return;
        }

        const won = outcome === side;
        const netPayout = won ? (shares - feeShares) : 0;
        const pnl = netPayout - cost;
        const stats = getStats(market.asset);
        stats.total++;
        if (won) stats.wins++;

        const wr = stats.total > 0 ? (stats.wins / stats.total * 100).toFixed(1) : '?';
        const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
        const emoji = won ? 'WIN' : 'LOSS';
        logger.money(`TAILSWEEP: ${emoji} ${label} — ${side} @ $${entryPrice.toFixed(2)} × ${shares}sh → ${pnlStr} | ${market.asset.toUpperCase()} wr=${wr}% (${stats.wins}/${stats.total})`);

        // Update the last log entry with outcome
        appendOrder({
            ts: new Date().toISOString(),
            asset: (market.asset || '').toUpperCase(),
            conditionId: market.conditionId,
            slotTimestamp: market.slotTimestamp,
            status: 'outcome',
            side, outcome, won, entryPrice, shares, cost,
            pnl: Math.round(pnl * 100) / 100,
            rollingWinRate: stats.total > 0 ? Math.round(stats.wins / stats.total * 1000) / 1000 : null,
            rollingTrades: stats.total,
        });
    }, waitMs);

    logger.info(`TAILSWEEP: outcome check scheduled in ${Math.round(waitMs / 1000)}s for ${market.asset.toUpperCase()}`);
}

// ── Live session stats (for dashboard) ───────────────────────────────────────

let sessionPnl = 0;
let sessionTrades = 0;
export function getSessionPnl() { return { pnl: sessionPnl, trades: sessionTrades }; }

async function paperTrade(market, dominantSide, dominantBid, dominantAsk, dominantLiq, slotEndMs) {
    const label = `${market.asset.toUpperCase()} ${(market.question || '').slice(0, 30)}`;

    // Log simulated entry for each threshold/size combo
    const entries = [];
    for (const th of paperThresholds) {
        if (dominantBid < th) continue;
        for (const sz of paperSizes) {
            if (dominantLiq < sz) continue;
            entries.push({ threshold: th, shares: sz, side: dominantSide, askPrice: dominantAsk });
        }
    }

    if (entries.length === 0) {
        const anyThresholdMet = paperThresholds.some(th => dominantBid >= th);
        const reason = anyThresholdMet ? 'no_ask_liquidity' : 'no_threshold_met';
        logger.info(`TAILSWEEP[PAPER]: ${label} — ${dominantSide} bid $${dominantBid.toFixed(2)} liq=${dominantLiq.toFixed(0)} — ${reason}`);
        logOrder(market, dominantSide, dominantBid, dominantAsk, dominantLiq, 'paper_skip', reason);
        return;
    }

    logger.trade(
        `TAILSWEEP[PAPER]: ${label} — ${dominantSide} bid=$${dominantBid.toFixed(2)} ask=$${dominantAsk.toFixed(2)} liq=${dominantLiq.toFixed(0)} | ` +
        `${entries.length} simulated entries`
    );

    // Wait for market to close + Gamma API to update resolution (typically 2-10 min)
    const initialWaitMs = Math.max(0, slotEndMs - Date.now()) + 3 * 60_000;
    logger.info(`TAILSWEEP[PAPER]: waiting ${Math.round(initialWaitMs / 1000)}s for resolution...`);
    await new Promise(r => setTimeout(r, initialWaitMs));

    let outcome = null;
    for (let attempt = 1; attempt <= 6; attempt++) {
        outcome = await checkOutcome(market);
        if (outcome) {
            logger.info(`TAILSWEEP[PAPER]: ${label} resolved → ${outcome} (attempt ${attempt})`);
            break;
        }
        if (attempt < 6) {
            logger.info(`TAILSWEEP[PAPER]: outcome not yet available (attempt ${attempt}/6), retrying in 60s...`);
            await new Promise(r => setTimeout(r, 60_000));
        }
    }
    if (!outcome) {
        logger.warn(`TAILSWEEP[PAPER]: ${label} — could not determine outcome after 6 attempts (~8 min)`);
    }

    for (const entry of entries) {
        const won = outcome === entry.side;
        const cost = entry.askPrice * entry.shares;
        const fee = computeFeeShares(entry.shares, entry.askPrice);
        const netPayout = won ? (entry.shares - fee) * 1.0 : 0;
        const pnl = netPayout - cost;

        const key = `${entry.threshold}-${entry.shares}`;
        if (paperStats[key]) {
            paperStats[key].trades++;
            if (won) paperStats[key].wins++;
            paperStats[key].pnl += pnl;
        }

        const winLoss = won ? '{green-fg}WIN{/green-fg}' : '{red-fg}LOSS{/red-fg}';
        const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;

        if (entry.threshold === 0.90 && entry.shares === 10) {
            logger.money(
                `TAILSWEEP[PAPER]: ${entry.side} @ $${entry.askPrice.toFixed(2)} × ${entry.shares}sh | th=$${entry.threshold} | ${won ? 'WIN' : 'LOSS'} ${pnlStr}`
            );
        }

        trades.push({
            asset: market.asset.toUpperCase(), side: entry.side, price: entry.askPrice,
            shares: entry.shares, cost, threshold: entry.threshold,
            fee: Math.round(fee * 10000) / 10000, won, pnl: Math.round(pnl * 100) / 100,
            outcome: outcome || 'unknown', ts: new Date().toISOString(), paper: true,
        });
    }

    logOrder(market, dominantSide, dominantBid, dominantAsk, dominantLiq,
        'paper_resolved', outcome || 'unknown', null, dominantAsk, outcome);
}

async function checkOutcome(market) {
    const slug = `${market.asset}-updown-5m-${market.slotTimestamp}`;
    try {
        const resp = await fetch(`${config.gammaHost}/markets/slug/${slug}`, { signal: AbortSignal.timeout(10000) });
        if (!resp.ok) return null;
        const data = await resp.json();
        if (!data) return null;

        // outcomePrices: "[\"1\",\"0\"]" or "[\"0\",\"1\"]"
        // [1,0] = UP won, [0,1] = DOWN won
        let prices = data.outcomePrices ?? data.outcome_prices;
        if (typeof prices === 'string') try { prices = JSON.parse(prices); } catch { prices = null; }

        if (Array.isArray(prices) && prices.length >= 2) {
            const p0 = parseFloat(prices[0]);
            const p1 = parseFloat(prices[1]);
            // Resolved: one side is exactly 1 (or > 0.95) and other is 0
            if (p0 > 0.95 && p1 < 0.05) return 'UP';
            if (p1 > 0.95 && p0 < 0.05) return 'DOWN';
        }

        // Fallback: umaResolutionStatus + outcomes
        if (data.umaResolutionStatus === 'resolved' || data.closed) {
            let outcomes = data.outcomes;
            if (typeof outcomes === 'string') try { outcomes = JSON.parse(outcomes); } catch { outcomes = null; }

            if (Array.isArray(outcomes) && Array.isArray(prices) && prices.length >= 2) {
                const p0 = parseFloat(prices[0]);
                const p1 = parseFloat(prices[1]);
                if (p0 > p1) return String(outcomes[0]).toUpperCase();
                if (p1 > p0) return String(outcomes[1]).toUpperCase();
            }
        }

        return null;
    } catch { return null; }
}

function logOrder(market, side, bid, ask, liq, status, reason, orderId, entryPrice, outcome) {
    appendOrder({
        ts: new Date().toISOString(),
        asset: (market.asset || '').toUpperCase(),
        conditionId: market.conditionId,
        question: (market.question || '').slice(0, 200),
        slotTimestamp: market.slotTimestamp,
        side, bid, ask, askLiquidity: liq,
        status, reason: reason || null,
        orderId: orderId || null,
        entryPrice: entryPrice || null,
        outcome: outcome || null,
        threshold: config.tailSweepThreshold,
        shares: config.tailSweepShares,
        secondsBefore: config.tailSweepSecondsBefore,
    });
}

export function cancelAllPending() {
    for (const [, timer] of pendingTimers) clearTimeout(timer);
    pendingTimers.clear();
}
