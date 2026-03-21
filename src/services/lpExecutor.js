/**
 * lpExecutor.js
 * Liquidity providing engine for Polymarket reward farming.
 * Posts two-sided quotes (bid+ask) on YES and NO tokens, monitors fills,
 * manages inventory via cross-hedging, and earns liquidity rewards.
 *
 * Set LP_PAPER=true to run in paper trading mode (no real orders, $500 virtual balance).
 */

import { Side, OrderType } from '@polymarket/clob-client';
import config from '../config/index.js';
import { getClient, submitOrderTimed } from './client.js';
import logger from '../utils/logger.js';
import * as risk from './riskManager.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const LP_LOG = path.join(DATA_DIR, 'lp_orders.jsonl');
const LP_PAPER_LOG = path.join(DATA_DIR, 'lp_paper.jsonl');

// ── Paper mode ───────────────────────────────────────────────────────────────

const PAPER_MODE = process.env.LP_PAPER === 'true';

// Paper state — virtual wallet with $500
const _paper = {
    usdc: 500,                    // virtual USDC balance
    positions: new Map(),         // conditionId -> { yesShares, noShares, yesCost, noCost }
    orders: new Map(),            // fakeOrderId -> { conditionId, tokenId, isBuy, isYes, price, shares, label, ts }
    totalFills: 0,
    totalRewardSamples: 0,
    totalInZoneSamples: 0,
    estimatedRewardsEarned: 0,
    pnlRealized: 0,
};

let _paperOrderSeq = 0;
function newPaperOrderId() { return `PAPER-${Date.now()}-${++_paperOrderSeq}`; }

function appendPaperLog(obj) {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    try { fs.appendFileSync(LP_PAPER_LOG, JSON.stringify(obj) + '\n'); } catch {}
}

export function getPaperStatus() {
    const totalValue = _paper.usdc + [..._paper.positions.values()].reduce((s, p) => {
        // Value at current midpoint — approximate as cost (conservative)
        return s + p.yesCost + p.noCost;
    }, 0);
    const rewardCapture = _paper.totalInZoneSamples / Math.max(1, _paper.totalRewardSamples);
    return {
        usdc: _paper.usdc,
        positions: _paper.positions.size,
        fills: _paper.totalFills,
        pnlRealized: _paper.pnlRealized,
        totalValue,
        rewardCapture: (rewardCapture * 100).toFixed(1) + '%',
        estimatedRewardsEarned: _paper.estimatedRewardsEarned,
    };
}

// ── Active quotes tracking ──────────────────────────────────────────────────

const _activeQuotes = new Map(); // conditionId -> { yesBidId, yesAskId, noBidId, noAskId, market, postedAt }
const _lastMidpoints = new Map(); // conditionId -> { mid, ts }
const _processedFills = new Set(); // orderId:matchedSize — track already-processed fills
const _fillTimestamps = new Map(); // conditionId -> { ts, market } (for auto-exit)

const LP_MAX_HOLD_HOURS = parseFloat(process.env.LP_MAX_HOLD_HOURS || '4');

export function getActiveQuotes() { return new Map(_activeQuotes); }

// ── Configuration ───────────────────────────────────────────────────────────

const LP_CONFIG = {
    baseSpread: 0.03,            // 3c from mid — wider = safer, still within ~4.5c reward zone
    refreshIntervalMs: 60_000,   // Re-quote every 60s
    fillCheckIntervalMs: 15_000, // Check for fills every 15s
    minOrderShares: 200,         // 200sh minimum — targets large reward markets
    maxOrderSizeUsd: 100,        // $100 per order (overridden in paper mode)
    maxExposureUsd: 200,         // SAFETY: max total position value across all markets
    maxPositionShares: 200,      // SAFETY: max shares of any token (1 fill then stop that side)
    hedgeSpread: 0.01,           // 1c hedge gap (tight hedge to reduce risk)
    hedgeTimeoutMs: 600_000,     // 10 min to fill cross-hedge
    volSpikeThreshold: 0.05,     // 5c midpoint move = volatility spike
    paperFillProbPer15s: 0.01,   // 1% per 15s — realistic for dead markets (~1 fill/25 min)
};

function appendLog(obj) {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    try { fs.appendFileSync(LP_LOG, JSON.stringify(obj) + '\n'); } catch {}
}

/**
 * Fetch orderbook for a token
 */
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
            bids,
            asks,
        };
    } catch { return null; }
}

/**
 * Cancel all active orders for a market
 */
async function cancelMarketOrders(conditionId) {
    const quotes = _activeQuotes.get(conditionId);
    if (!quotes) return;

    if (PAPER_MODE) {
        // Remove paper orders and refund reserved USDC
        for (const id of [quotes.yesBidId, quotes.yesAskId, quotes.noBidId, quotes.noAskId]) {
            if (!id) continue;
            const o = _paper.orders.get(id);
            if (o && o.isBuy) {
                _paper.usdc += o.price * o.shares; // refund cost reservation
            }
            _paper.orders.delete(id);
        }
    } else {
        const client = getClient();
        const ids = [quotes.yesBidId, quotes.yesAskId, quotes.noBidId, quotes.noAskId].filter(Boolean);
        for (const id of ids) {
            try { await client.cancelOrder(id); } catch {}
        }
    }
    _activeQuotes.delete(conditionId);
}

/**
 * Cancel ALL active orders across all markets
 */
export async function cancelAllOrders() {
    for (const [conditionId] of _activeQuotes) {
        await cancelMarketOrders(conditionId);
    }
    logger.info('LP: all orders cancelled');
}

/**
 * Round price to valid tick size
 */
function roundToTick(price, tickSize) {
    const tick = parseFloat(tickSize) || 0.01;
    return Math.round(price / tick) * tick;
}

/**
 * Place a single GTC limit order, respecting risk limits.
 * In PAPER_MODE: simulates the order without real API calls.
 */
async function placeOrder(market, tokenId, side, price, shares, label) {
    const isBuy = side === Side.BUY;
    const isYes = tokenId === market.yesTokenId;
    const fillSide = isBuy ? (isYes ? 'YES_BUY' : 'NO_BUY') : (isYes ? 'YES_SELL' : 'NO_SELL');

    if (!PAPER_MODE) {
        const check = risk.canPlaceOrder(market.conditionId, fillSide, shares, price);
        if (!check.allowed) {
            logger.info(`LP: ${label} blocked — ${check.reason}`);
            return null;
        }
    }

    if (PAPER_MODE) {
        // Check paper balance for buys
        const cost = isBuy ? price * shares : 0;
        if (isBuy && _paper.usdc < cost) {
            logger.info(`LP [PAPER]: ${label} skipped — insufficient balance ($${_paper.usdc.toFixed(2)} < $${cost.toFixed(2)})`);
            return null;
        }
        if (isBuy) _paper.usdc -= cost; // reserve cost

        const fakeId = newPaperOrderId();
        _paper.orders.set(fakeId, { conditionId: market.conditionId, tokenId, isBuy, isYes, price, shares, label, ts: Date.now() });
        logger.info(`LP [PAPER]: ${label} @ $${price.toFixed(2)} × ${shares}sh | bal=$${_paper.usdc.toFixed(2)}`);
        appendPaperLog({ ts: new Date().toISOString(), action: 'place', conditionId: market.conditionId, fillSide, price, shares, label, orderId: fakeId });
        return fakeId;
    }

    // Live mode
    try {
        const tickSize = market.tickSize || '0.01';
        const { res } = await submitOrderTimed(
            { tokenID: tokenId, side, price: roundToTick(price, tickSize), size: shares },
            { tickSize, negRisk: market.negRisk || false },
            OrderType.GTC,
        );
        if (res?.success) {
            logger.info(`LP: ${label} placed — ${res.orderID?.slice(0, 10)}... @ $${price.toFixed(2)} × ${shares}sh`);
            appendLog({ ts: new Date().toISOString(), action: 'place', conditionId: market.conditionId, tokenId, side: isBuy ? 'BUY' : 'SELL', price, shares, orderId: res.orderID, label });
            return res.orderID;
        } else {
            logger.warn(`LP: ${label} rejected — ${res?.errorMsg || 'unknown'}`);
            return null;
        }
    } catch (err) {
        logger.warn(`LP: ${label} error — ${err.message}`);
        return null;
    }
}

/**
 * Post two-sided quotes for a market
 */
export async function postQuotes(market) {
    if (!PAPER_MODE && risk.isHalted()) return;

    if (!PAPER_MODE) {
        const suitability = risk.isMarketSuitable(market);
        if (!suitability.ok) {
            logger.info(`LP: skipping ${market.question?.slice(0, 40)} — ${suitability.reason}`);
            return;
        }
    }

    // Fetch real orderbooks (even in paper mode — we price against real book)
    const [yesBook, noBook] = await Promise.all([
        fetchBook(market.yesTokenId),
        fetchBook(market.noTokenId),
    ]);

    if (!yesBook?.midpoint || !noBook?.midpoint) {
        logger.warn(`LP: no orderbook for ${market.question?.slice(0, 40)}`);
        return;
    }

    // Volatility check — skip in paper mode to observe all scenarios
    if (!PAPER_MODE) {
        const lastMid = _lastMidpoints.get(market.conditionId);
        if (lastMid && Math.abs(yesBook.midpoint - lastMid.mid) >= LP_CONFIG.volSpikeThreshold) {
            risk.triggerVolatilityPause(market.conditionId);
            await cancelMarketOrders(market.conditionId);
            _lastMidpoints.set(market.conditionId, { mid: yesBook.midpoint, ts: Date.now() });
            return;
        }
    }
    _lastMidpoints.set(market.conditionId, { mid: yesBook.midpoint, ts: Date.now() });

    // Cancel existing quotes before re-quoting
    await cancelMarketOrders(market.conditionId);

    // Paper mode: use flat spread. Live mode: use inventory-skewed spread
    const { bidSpread, askSpread } = PAPER_MODE
        ? { bidSpread: LP_CONFIG.baseSpread, askSpread: LP_CONFIG.baseSpread }
        : risk.getSkewedSpread(market.conditionId, LP_CONFIG.baseSpread);

    // If CLOB book is thin (spread > 0.15), book midpoint is unreliable (e.g. $0.01/$0.99).
    // Fall back to the rewards API price (market.yesPrice) which reflects actual market consensus.
    const yesSpread = yesBook.bestAsk - yesBook.bestBid;
    const noSpread = noBook.bestAsk - noBook.bestBid;
    const THIN_BOOK_THRESHOLD = 0.15;
    const yesMid = yesSpread > THIN_BOOK_THRESHOLD
        ? (market.yesPrice || yesBook.midpoint)
        : yesBook.midpoint;
    const noMid = noSpread > THIN_BOOK_THRESHOLD
        ? (market.noPrice || noBook.midpoint)
        : noBook.midpoint;
    const shares = Math.max(LP_CONFIG.minOrderShares, market.minSize || LP_CONFIG.minOrderShares);
    const tickSize = market.tickSize || '0.01';
    const tick = parseFloat(tickSize) || 0.01;
    const label = (market.question || '').slice(0, 30);

    // Target bid: mid - spread
    // On liquid books: also cap at bestBid to avoid crossing the ask
    // On thin books: skip bestBid cap (it'd be ~$0.01 and kill the price)
    const maxRewardSpread = market.maxSpread || 0.05;
    const targetYesBid = yesMid - bidSpread;
    const targetNoBid = noMid - bidSpread;

    const yesBookLiquid = yesSpread <= THIN_BOOK_THRESHOLD;
    const noBookLiquid = noSpread <= THIN_BOOK_THRESHOLD;

    const yesBidPrice = roundToTick(
        Math.max(yesMid - maxRewardSpread + tick,
            yesBookLiquid ? Math.min(targetYesBid, yesBook.bestBid) : targetYesBid),
        tickSize
    );
    const noBidPrice = roundToTick(
        Math.max(noMid - maxRewardSpread + tick,
            noBookLiquid ? Math.min(targetNoBid, noBook.bestBid) : targetNoBid),
        tickSize
    );

    // Final sanity: never bid >= bestAsk on liquid books (instant fill)
    const safeYesBid = (yesBookLiquid && yesBidPrice >= yesBook.bestAsk)
        ? roundToTick(yesBook.bestAsk - tick, tickSize)
        : yesBidPrice;
    const safeNoBid = (noBookLiquid && noBidPrice >= noBook.bestAsk)
        ? roundToTick(noBook.bestAsk - tick, tickSize)
        : noBidPrice;

    // Log spread diagnostic
    const yesInZone = safeYesBid >= yesMid - maxRewardSpread;
    const noInZone = safeNoBid >= noMid - maxRewardSpread;
    logger.info(
        `LP${PAPER_MODE ? ' [PAPER]' : ''}: ${label.slice(0, 25)} | ` +
        `YES mid=$${yesMid.toFixed(2)} bid=$${safeYesBid.toFixed(2)} zone=${yesInZone ? 'IN' : 'OUT'} | ` +
        `NO mid=$${noMid.toFixed(2)} bid=$${safeNoBid.toFixed(2)} zone=${noInZone ? 'IN' : 'OUT'}`
    );

    // Check cost vs budget
    const yesCost = safeYesBid * shares;
    const noCost = safeNoBid * shares;
    if (yesCost > LP_CONFIG.maxOrderSizeUsd || noCost > LP_CONFIG.maxOrderSizeUsd) {
        logger.info(`LP: ${label} — order cost $${Math.max(yesCost, noCost).toFixed(2)} exceeds max $${LP_CONFIG.maxOrderSizeUsd} — skipping`);
        return;
    }

    // SAFETY: check exposure + position limits before placing BUY orders
    let skipBuys = false;
    if (PAPER_MODE) {
        const totalExposure = [..._paper.positions.values()].reduce(
            (s, p) => s + p.yesCost + p.noCost, 0);
        if (totalExposure >= LP_CONFIG.maxExposureUsd) {
            logger.info(`LP [PAPER]: ${label} — exposure $${totalExposure.toFixed(2)} >= cap $${LP_CONFIG.maxExposureUsd} — bids paused, asks only`);
            skipBuys = true;
        }
    }

    // Check position limit per token — don't keep buying if already holding max shares
    const pos = PAPER_MODE ? _paper.positions.get(market.conditionId) : risk.getPositions().get(market.conditionId);
    const yesHeld = pos?.yesShares || 0;
    const noHeld = pos?.noShares || 0;
    const skipYesBuy = skipBuys || yesHeld >= LP_CONFIG.maxPositionShares;
    const skipNoBuy = skipBuys || noHeld >= LP_CONFIG.maxPositionShares;

    let yesBidId = null;
    let noBidId = null;
    if (!skipYesBuy) {
        yesBidId = await placeOrder(market, market.yesTokenId, Side.BUY, safeYesBid, shares, `YES BID ${label}`);
    } else if (yesHeld >= LP_CONFIG.maxPositionShares) {
        logger.info(`LP${PAPER_MODE ? ' [PAPER]' : ''}: ${label} YES BID skipped — already holding ${yesHeld}sh (max ${LP_CONFIG.maxPositionShares})`);
    }
    if (!skipNoBuy) {
        noBidId = await placeOrder(market, market.noTokenId, Side.BUY, safeNoBid, shares, `NO BID ${label}`);
    } else if (noHeld >= LP_CONFIG.maxPositionShares) {
        logger.info(`LP${PAPER_MODE ? ' [PAPER]' : ''}: ${label} NO BID skipped — already holding ${noHeld}sh (max ${LP_CONFIG.maxPositionShares})`);
    }

    // SELL orders — always try to offload inventory (tighter spread to exit faster)
    let yesAskId = null;
    let noAskId = null;
    if (pos && (pos.yesShares || 0) >= shares) {
        yesAskId = await placeOrder(market, market.yesTokenId, Side.SELL, roundToTick(yesMid + askSpread, tickSize), shares, `YES ASK ${label}`);
    }
    if (pos && (pos.noShares || 0) >= shares) {
        noAskId = await placeOrder(market, market.noTokenId, Side.SELL, roundToTick(noMid + askSpread, tickSize), shares, `NO ASK ${label}`);
    }

    _activeQuotes.set(market.conditionId, { yesBidId, yesAskId, noBidId, noAskId, market, postedAt: Date.now() });

    // PAPER: track reward score every cycle for ALL resting orders (bids + asks)
    // This runs in postQuotes (every 60s) regardless of position limits
    if (PAPER_MODE) {
        const dailyRate = market.dailyReward || 0;
        let ordersInZone = 0;

        // Count resting bid orders in reward zone
        if (yesBidId && yesInZone) ordersInZone++;
        if (noBidId && noInZone) ordersInZone++;

        // Count resting ask orders in reward zone
        if (yesAskId) {
            const yesAskPrice = roundToTick(yesMid + askSpread, tickSize);
            if (yesAskPrice <= yesMid + maxRewardSpread) ordersInZone++;
        }
        if (noAskId) {
            const noAskPrice = roundToTick(noMid + askSpread, tickSize);
            if (noAskPrice <= noMid + maxRewardSpread) ordersInZone++;
        }

        // Each order earns 1 minute's worth of reward (cycle = 60s)
        // Two-sided (bid+ask on same token) gets 3x bonus
        const hasTwoSidedYes = yesBidId && yesAskId;
        const hasTwoSidedNo = noBidId && noAskId;
        const bonusMultiplier = (hasTwoSidedYes || hasTwoSidedNo) ? 3 : 1;

        if (ordersInZone > 0) {
            _paper.totalRewardSamples++;
            _paper.totalInZoneSamples++;
            // Approximate: (daily_rate / 1440 minutes) × orders_in_zone/4 × bonus
            const minuteReward = (dailyRate / 1440) * (ordersInZone / 4) * bonusMultiplier;
            _paper.estimatedRewardsEarned += minuteReward;
        } else {
            _paper.totalRewardSamples++;
        }
    }
}

/**
 * Simulate a paper fill: update virtual inventory and balance
 */
function simulatePaperFill(conditionId, orderId, order) {
    const { isYes, isBuy, price, shares, label } = order;

    if (isBuy) {
        // Cost was already reserved in placeOrder — just add inventory
        const pos = _paper.positions.get(conditionId) || { yesShares: 0, noShares: 0, yesCost: 0, noCost: 0 };
        if (isYes) { pos.yesShares += shares; pos.yesCost += price * shares; }
        else       { pos.noShares += shares;  pos.noCost  += price * shares; }
        _paper.positions.set(conditionId, pos);
        logger.info(`LP [PAPER FILL]: BUY ${isYes ? 'YES' : 'NO'} ${shares}sh @ $${price.toFixed(2)} — ${label} | bal=$${_paper.usdc.toFixed(2)}`);
    } else {
        // Sell: remove inventory, add USDC
        const pos = _paper.positions.get(conditionId);
        if (pos) {
            if (isYes && pos.yesShares >= shares) {
                const avgCost = pos.yesCost / pos.yesShares;
                const realized = (price - avgCost) * shares;
                _paper.pnlRealized += realized;
                pos.yesShares -= shares;
                pos.yesCost -= avgCost * shares;
            } else if (!isYes && pos.noShares >= shares) {
                const avgCost = pos.noCost / pos.noShares;
                const realized = (price - avgCost) * shares;
                _paper.pnlRealized += realized;
                pos.noShares -= shares;
                pos.noCost -= avgCost * shares;
            }
            _paper.usdc += price * shares;
        }
        logger.info(`LP [PAPER FILL]: SELL ${isYes ? 'YES' : 'NO'} ${shares}sh @ $${price.toFixed(2)} — ${label} | bal=$${_paper.usdc.toFixed(2)} | PnL=$${_paper.pnlRealized.toFixed(2)}`);
    }

    _paper.totalFills++;
    if (isBuy && !_fillTimestamps.has(conditionId)) {
        const q = _activeQuotes.get(conditionId);
        if (q?.market) _fillTimestamps.set(conditionId, { ts: Date.now(), market: q.market });
    }
    appendPaperLog({ ts: new Date().toISOString(), action: 'fill', conditionId, isYes, isBuy, price, shares, label, pnlRealized: _paper.pnlRealized });
    _paper.orders.delete(orderId);
}

/**
 * Check for fills on active quotes and manage inventory
 */
export async function checkFills() {
    if (!PAPER_MODE && risk.isHalted()) return;

    if (PAPER_MODE) {
        // Simulate fills: for each resting paper order, check if real book has crossed our price
        // Also track reward zone samples
        for (const [conditionId, quotes] of _activeQuotes) {
            const mkt = quotes.market;
            const [yesBook, noBook] = await Promise.all([
                fetchBook(mkt.yesTokenId),
                fetchBook(mkt.noTokenId),
            ]);

            const maxSpread = mkt.maxSpread || 0.05;

            for (const orderId of [quotes.yesBidId, quotes.noBidId, quotes.yesAskId, quotes.noAskId]) {
                if (!orderId) continue;
                const o = _paper.orders.get(orderId);
                if (!o) continue;

                const book = o.isYes ? yesBook : noBook;
                if (!book) continue;

                // Reward zone tracking (for bid orders only)
                if (o.isBuy) {
                    _paper.totalRewardSamples++;
                    // Use thin-book-aware midpoint — same logic as postQuotes
                    const bookSpread = book.bestAsk - book.bestBid;
                    const rawMid = book.midpoint || (book.bestBid + book.bestAsk) / 2;
                    const mid = bookSpread > 0.15
                        ? (o.isYes ? (mkt.yesPrice || rawMid) : (mkt.noPrice || rawMid))
                        : rawMid;
                    const inZone = o.price >= mid - maxSpread;
                    if (inZone) {
                        _paper.totalInZoneSamples++;
                        // Estimate reward contribution for this sample
                        // Quadratic score: ((v-s)/v)² × b where v=our size, s=0 (we're the only scorer in paper), b=daily rate
                        const dailyRate = mkt.dailyReward || 0;
                        // Earn 1 minute's worth of reward (sampled every 15s, 4 samples/min, paid per minute)
                        _paper.estimatedRewardsEarned += (dailyRate / 24 / 60) * (15 / 60);
                    }
                }

                // Simulate fill: book crosses our bid, or random fill on liquid markets
                let filled = false;
                if (o.isBuy && book.bestAsk <= o.price) {
                    // Book crossed our bid — we'd fill instantly (this is the problem on thin markets)
                    filled = true;
                    logger.warn(`LP [PAPER]: ${o.label} would INSTANT FILL (bestAsk=$${book.bestAsk.toFixed(2)} <= bid=$${o.price.toFixed(2)}) — thin market!`);
                } else if (o.isBuy && Math.random() < LP_CONFIG.paperFillProbPer15s) {
                    // Random fill — represents a real seller hitting our bid
                    filled = true;
                } else if (!o.isBuy && book.bestBid >= o.price) {
                    // Ask crossed by real bid
                    filled = true;
                }

                if (filled) {
                    simulatePaperFill(conditionId, orderId, o);
                    // Cross-hedge: if YES filled, bid on NO (and vice versa)
                    // Track hedge order in _activeQuotes so it gets cancelled/refunded on re-quote
                    if (o.isBuy && o.isYes && yesBook) {
                        const hedgePrice = roundToTick(1.0 - o.price - LP_CONFIG.hedgeSpread, mkt.tickSize || '0.01');
                        if (hedgePrice > 0.01) {
                            const hedgeId = await placeOrder(mkt, mkt.noTokenId, Side.BUY, hedgePrice, o.shares, `HEDGE NO BID`);
                            if (hedgeId) {
                                const q = _activeQuotes.get(conditionId);
                                if (q && !q.noBidId) q.noBidId = hedgeId;
                            }
                        }
                    } else if (o.isBuy && !o.isYes && noBook) {
                        const hedgePrice = roundToTick(1.0 - o.price - LP_CONFIG.hedgeSpread, mkt.tickSize || '0.01');
                        if (hedgePrice > 0.01) {
                            const hedgeId = await placeOrder(mkt, mkt.yesTokenId, Side.BUY, hedgePrice, o.shares, `HEDGE YES BID`);
                            if (hedgeId) {
                                const q = _activeQuotes.get(conditionId);
                                if (q && !q.yesBidId) q.yesBidId = hedgeId;
                            }
                        }
                    }
                }
            }
        }
        return;
    }

    // Live mode
    const client = getClient();
    for (const [conditionId, quotes] of _activeQuotes) {
        const ids = [
            { id: quotes.yesBidId, side: 'YES_BUY', tokenId: quotes.market.yesTokenId },
            { id: quotes.yesAskId, side: 'YES_SELL', tokenId: quotes.market.yesTokenId },
            { id: quotes.noBidId, side: 'NO_BUY', tokenId: quotes.market.noTokenId },
            { id: quotes.noAskId, side: 'NO_SELL', tokenId: quotes.market.noTokenId },
        ];

        for (const { id, side, tokenId } of ids) {
            if (!id) continue;
            try {
                const order = await client.getOrder(id);
                if (!order) continue;

                const matched = parseFloat(order.size_matched || '0');
                const price = parseFloat(order.price || '0');

                if (order.status === 'MATCHED' || matched > 0) {
                    const fillKey = `${id}:${matched}`;
                    if (matched > 0 && !_processedFills.has(fillKey)) {
                        _processedFills.add(fillKey);
                        risk.recordFill(conditionId, side, matched, price);
                        if (side.includes('BUY') && !_fillTimestamps.has(conditionId)) _fillTimestamps.set(conditionId, { ts: Date.now(), market: quotes.market });
                        logger.info(`LP: FILL ${side} ${matched}sh @ $${price.toFixed(2)} — ${quotes.market.question?.slice(0, 30)}`);
                        appendLog({ ts: new Date().toISOString(), action: 'fill', conditionId, side, price, shares: matched, orderId: id });

                        if (side === 'YES_BUY') {
                            const hedgePrice = roundToTick(1.0 - price - LP_CONFIG.hedgeSpread, quotes.market.tickSize || '0.01');
                            if (hedgePrice > 0.01) {
                                await placeOrder(quotes.market, quotes.market.noTokenId, Side.BUY, hedgePrice, matched, `HEDGE NO BID`);
                            }
                        } else if (side === 'NO_BUY') {
                            const hedgePrice = roundToTick(1.0 - price - LP_CONFIG.hedgeSpread, quotes.market.tickSize || '0.01');
                            if (hedgePrice > 0.01) {
                                await placeOrder(quotes.market, quotes.market.yesTokenId, Side.BUY, hedgePrice, matched, `HEDGE YES BID`);
                            }
                        }

                        setTimeout(async () => {
                            try {
                                const book = await fetchBook(tokenId);
                                if (!book) return;
                                if (side.includes('BUY') && book.midpoint < price - 0.02) risk.recordAdverseSelection(conditionId);
                                else if (side.includes('SELL') && book.midpoint > price + 0.02) risk.recordAdverseSelection(conditionId);
                            } catch {}
                        }, 60_000);
                    }
                }
            } catch {}
        }
    }
}

/**
 * Force-sell positions held longer than LP_MAX_HOLD_HOURS.
 * Sells at bestBid - 1 tick to ensure fill. Skips if book is dead.
 */
export async function checkStalePositions() {
    const maxAgeMs = LP_MAX_HOLD_HOURS * 3600_000;
    const now = Date.now();

    for (const [conditionId, fillData] of _fillTimestamps) {
        const firstFillTs = fillData.ts || fillData; // backwards compat
        if (now - firstFillTs < maxAgeMs) continue;

        const market = fillData.market || _activeQuotes.get(conditionId)?.market;
        if (!market) continue;

        // Get current position
        const pos = PAPER_MODE
            ? _paper.positions.get(conditionId)
            : risk.getPositions().get(conditionId);
        if (!pos) { _fillTimestamps.delete(conditionId); continue; }

        const yesHeld = pos.yesShares || 0;
        const noHeld = pos.noShares || 0;
        if (yesHeld < 1 && noHeld < 1) { _fillTimestamps.delete(conditionId); continue; }

        const ageHours = ((now - firstFillTs) / 3600_000).toFixed(1);
        const label = (market.question || '').slice(0, 30);

        // Fetch books for exit pricing
        const [yesBook, noBook] = await Promise.all([
            fetchBook(market.yesTokenId),
            fetchBook(market.noTokenId),
        ]);

        const tick = parseFloat(market.tickSize || '0.01');

        // Force-sell YES if held
        if (yesHeld >= 1 && yesBook) {
            const exitPrice = roundToTick(yesBook.bestBid - tick, market.tickSize || '0.01');
            if (exitPrice < 0.05) {
                logger.warn(`LP: FORCE EXIT skipped YES ${label} — bestBid too low ($${yesBook.bestBid.toFixed(2)})`);
                appendLog({ ts: new Date().toISOString(), action: 'force_exit_no_book', conditionId, side: 'YES', ageHours: parseFloat(ageHours) });
            } else {
                logger.warn(`LP: FORCE EXIT YES ${yesHeld}sh @ $${exitPrice.toFixed(2)} — held ${ageHours}h — ${label}`);
                await placeOrder(market, market.yesTokenId, Side.SELL, exitPrice, yesHeld, `FORCE EXIT YES ${label}`);
                appendLog({ ts: new Date().toISOString(), action: 'force_exit', conditionId, side: 'YES', shares: yesHeld, price: exitPrice, ageHours: parseFloat(ageHours) });
            }
        }

        // Force-sell NO if held
        if (noHeld >= 1 && noBook) {
            const exitPrice = roundToTick(noBook.bestBid - tick, market.tickSize || '0.01');
            if (exitPrice < 0.05) {
                logger.warn(`LP: FORCE EXIT skipped NO ${label} — bestBid too low ($${noBook.bestBid.toFixed(2)})`);
                appendLog({ ts: new Date().toISOString(), action: 'force_exit_no_book', conditionId, side: 'NO', ageHours: parseFloat(ageHours) });
            } else {
                logger.warn(`LP: FORCE EXIT NO ${noHeld}sh @ $${exitPrice.toFixed(2)} — held ${ageHours}h — ${label}`);
                await placeOrder(market, market.noTokenId, Side.SELL, exitPrice, noHeld, `FORCE EXIT NO ${label}`);
                appendLog({ ts: new Date().toISOString(), action: 'force_exit', conditionId, side: 'NO', shares: noHeld, price: exitPrice, ageHours: parseFloat(ageHours) });
            }
        }

        _fillTimestamps.delete(conditionId);
    }
}

/**
 * Full refresh cycle: re-scan books and re-quote all markets
 */
export async function refreshAllQuotes(markets) {
    if (!PAPER_MODE && risk.isHalted()) {
        logger.warn('LP: halted — skipping refresh');
        return;
    }

    for (const market of markets) {
        try {
            await postQuotes(market);
        } catch (err) {
            logger.warn(`LP: error quoting ${market.question?.slice(0, 30)} — ${err.message}`);
        }
        await new Promise(r => setTimeout(r, 2000));
    }
}

export { LP_CONFIG };
