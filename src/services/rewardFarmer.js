/**
 * rewardFarmer.js
 * Reward farming executor — posts bid-only orders at the OUTER EDGE of the
 * reward zone, intentionally priced to NOT fill, collecting rewards just for
 * having resting orders in-zone.
 *
 * Zero inventory risk when working correctly. Safety: cancel if price moves
 * within 3 cents of our bid.
 */

import { Side, OrderType } from '@polymarket/clob-client';
import config from '../config/index.js';
import { getClient, submitOrderTimed } from './client.js';
import { validateOrderbook, isCircuitBroken } from '../utils/orderbookGuard.js';
import logger from '../utils/logger.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const FARM_LOG = path.join(DATA_DIR, 'lp_farm.jsonl');

function appendLog(obj) {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    try { fs.appendFileSync(FARM_LOG, JSON.stringify(obj) + '\n'); } catch {}
}

// ── Config ──────────────────────────────────────────────────────────────────

const SAFETY_BUFFER = 0.03;         // 3 cents — don't post if bestAsk is within this of our bid
const REFRESH_LOG_EVERY = 5;        // log full status every N refreshes
const THIN_BOOK_THRESHOLD = 0.15;   // use rewards API price if book spread > this

// ── State ───────────────────────────────────────────────────────────────────

const _farmOrders = new Map();      // conditionId -> { yesBidId, noBidId, market, postedAt }
let _refreshCount = 0;
let _rewardSamples = 0;
let _inZoneSamples = 0;
let _accidentalFills = 0;
let _estimatedRewards = 0;

export function getFarmStats() {
    return {
        marketsActive: _farmOrders.size,
        rewardSamples: _rewardSamples,
        inZoneSamples: _inZoneSamples,
        inZoneRate: _rewardSamples > 0 ? (_inZoneSamples / _rewardSamples * 100).toFixed(1) + '%' : '0%',
        accidentalFills: _accidentalFills,
        estimatedRewardsPerDay: _estimatedRewards,
    };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function roundToTick(price, tickSize) {
    const tick = parseFloat(tickSize) || 0.01;
    return Math.round(price / tick) * tick;
}

async function fetchBook(tokenId) {
    try {
        const resp = await fetch(`${config.clobHost}/book?token_id=${tokenId}`, {
            signal: AbortSignal.timeout(8000),
        });
        if (!resp.ok) return null;
        const book = await resp.json();
        const bids = book.bids || [];
        const asks = book.asks || [];
        return {
            bestBid: bids.length > 0 ? parseFloat(bids[0].price) : 0,
            bestAsk: asks.length > 0 ? parseFloat(asks[0].price) : 1,
            midpoint: bids.length > 0 && asks.length > 0
                ? (parseFloat(bids[0].price) + parseFloat(asks[0].price)) / 2
                : null,
            bids, asks,
        };
    } catch { return null; }
}

// ── Cancel ──────────────────────────────────────────────────────────────────

async function cancelMarketOrders(conditionId) {
    const orders = _farmOrders.get(conditionId);
    if (!orders) return;

    if (config.dryRun) {
        _farmOrders.delete(conditionId);
        return;
    }

    const client = getClient();
    for (const id of [orders.yesBidId, orders.noBidId].filter(Boolean)) {
        try { await client.cancelOrder(id); } catch {}
    }
    _farmOrders.delete(conditionId);
}

export async function cancelAllFarmOrders() {
    for (const [cid] of _farmOrders) {
        await cancelMarketOrders(cid);
    }
    logger.info('FARM: all orders cancelled');
}

// ── Post farm orders ────────────────────────────────────────────────────────

export async function postFarmOrders(market, capitalUsd = 50) {
    if (isCircuitBroken()) {
        logger.warn(`FARM: circuit breaker active — skipping ${market.question?.slice(0, 40)}`);
        return;
    }

    const rawYes = await fetchBook(market.yesTokenId);
    const rawNo = await fetchBook(market.noTokenId);
    const yesBook = validateOrderbook(market.yesTokenId, rawYes);
    const noBook = validateOrderbook(market.noTokenId, rawNo);

    // Need at least one valid book to farm
    if (!yesBook && !noBook) return;

    // Cancel existing before re-posting
    await cancelMarketOrders(market.conditionId);

    const maxSpread = market.maxSpread || 0.05;
    const tickSize = market.tickSize || '0.01';
    const tick = parseFloat(tickSize) || 0.01;
    const minShares = market.minSize || 20;
    const label = (market.question || '').slice(0, 35);

    let yesBidId = null;
    let noBidId = null;

    // YES side
    if (yesBook) {
        const bookSpread = yesBook.bestAsk - yesBook.bestBid;
        const mid = bookSpread > THIN_BOOK_THRESHOLD
            ? (market.yesPrice || yesBook.midpoint || 0.5)
            : (yesBook.midpoint || 0.5);

        // Outer edge of reward zone: mid - maxSpread + 1 tick
        const farmBid = roundToTick(mid - maxSpread + tick, tickSize);

        // Size: target capitalUsd per side, floored at market's minimum
        const shares = Math.max(minShares, Math.floor(capitalUsd / Math.max(farmBid, 0.01)));

        // Safety: don't post if bestAsk is too close
        if (farmBid > 0.01 && farmBid < 0.99 && yesBook.bestAsk > farmBid + SAFETY_BUFFER) {
            yesBidId = await placeFarmOrder(market, market.yesTokenId, farmBid, shares, `YES ${label}`);

            // Track reward zone
            _rewardSamples++;
            if (farmBid >= mid - maxSpread) {
                _inZoneSamples++;
                _estimatedRewards += (market.dailyReward || 0) / 1440; // 1 minute's worth
            }
        } else if (farmBid > 0.01) {
            logger.info(`FARM: ${label} YES skip — bestAsk $${yesBook.bestAsk.toFixed(2)} too close to bid $${farmBid.toFixed(2)}`);
        }
    }

    // NO side
    if (noBook) {
        const bookSpread = noBook.bestAsk - noBook.bestBid;
        const mid = bookSpread > THIN_BOOK_THRESHOLD
            ? (market.noPrice || noBook.midpoint || 0.5)
            : (noBook.midpoint || 0.5);

        const farmBid = roundToTick(mid - maxSpread + tick, tickSize);

        // Size: target capitalUsd per side, floored at market's minimum
        const shares = Math.max(minShares, Math.floor(capitalUsd / Math.max(farmBid, 0.01)));

        if (farmBid > 0.01 && farmBid < 0.99 && noBook.bestAsk > farmBid + SAFETY_BUFFER) {
            noBidId = await placeFarmOrder(market, market.noTokenId, farmBid, shares, `NO ${label}`);

            _rewardSamples++;
            if (farmBid >= mid - maxSpread) {
                _inZoneSamples++;
                _estimatedRewards += (market.dailyReward || 0) / 1440;
            }
        } else if (farmBid > 0.01) {
            logger.info(`FARM: ${label} NO skip — bestAsk $${noBook.bestAsk.toFixed(2)} too close to bid $${farmBid.toFixed(2)}`);
        }
    }

    if (yesBidId || noBidId) {
        _farmOrders.set(market.conditionId, { yesBidId, noBidId, market, postedAt: Date.now() });
    }
}

async function placeFarmOrder(market, tokenId, price, shares, label) {
    if (config.dryRun) {
        logger.info(`FARM [PAPER]: BID ${label} @ $${price.toFixed(2)} × ${shares}sh`);
        appendLog({ ts: new Date().toISOString(), action: 'place', conditionId: market.conditionId, tokenId, price, shares, label, paper: true });
        return `PAPER-${Date.now()}`;
    }

    try {
        const { res } = await submitOrderTimed(
            { tokenID: tokenId, side: Side.BUY, price, size: shares },
            { tickSize: market.tickSize || '0.01', negRisk: market.negRisk || false },
            OrderType.GTC,
        );
        if (res?.success) {
            logger.info(`FARM: BID ${label} @ $${price.toFixed(2)} × ${shares}sh — ${res.orderID?.slice(0, 10)}...`);
            appendLog({ ts: new Date().toISOString(), action: 'place', conditionId: market.conditionId, tokenId, price, shares, label, orderId: res.orderID });
            return res.orderID;
        } else {
            logger.warn(`FARM: ${label} rejected — ${res?.errorMsg || 'unknown'}`);
            return null;
        }
    } catch (err) {
        logger.warn(`FARM: ${label} error — ${err.message}`);
        return null;
    }
}

// ── Refresh all ─────────────────────────────────────────────────────────────

export async function refreshAllFarmOrders(markets, capitalUsd = 50) {
    _refreshCount++;

    for (const market of markets) {
        try {
            await postFarmOrders(market, capitalUsd);
        } catch (err) {
            logger.warn(`FARM: error on ${market.question?.slice(0, 30)} — ${err.message}`);
        }
        await new Promise(r => setTimeout(r, 1500));
    }

    // Check for accidental fills (live mode only)
    if (!config.dryRun) {
        await checkForFills();
    }

    if (_refreshCount % REFRESH_LOG_EVERY === 0) {
        const stats = getFarmStats();
        logger.info(
            `FARM STATUS: ${stats.marketsActive} markets | zone=${stats.inZoneRate} | ` +
            `est=$${stats.estimatedRewardsPerDay.toFixed(4)}/day | fills=${stats.accidentalFills} | cycle=${_refreshCount}`
        );
    }
}

// ── Fill detection (live mode — accidental fills are bad) ───────────────────

async function checkForFills() {
    const client = getClient();
    for (const [conditionId, orders] of _farmOrders) {
        for (const id of [orders.yesBidId, orders.noBidId].filter(Boolean)) {
            try {
                const order = await client.getOrder(id);
                if (!order) continue;
                const matched = parseFloat(order.size_matched || '0');
                if (matched > 0) {
                    _accidentalFills++;
                    const price = parseFloat(order.price || '0');
                    logger.warn(`FARM: ACCIDENTAL FILL ${matched}sh @ $${price.toFixed(2)} on ${conditionId.slice(0, 10)}... — cancelling remaining`);
                    appendLog({ ts: new Date().toISOString(), action: 'accidental_fill', conditionId, price, shares: matched });
                    // Cancel to prevent more fills
                    await cancelMarketOrders(conditionId);
                }
            } catch {}
        }
    }
}
