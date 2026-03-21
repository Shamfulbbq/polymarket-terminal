/**
 * rewardScanner.js
 * Finds the best Polymarket markets for liquidity reward farming.
 * Fetches reward configs, filters for safe/profitable markets, and
 * returns ranked targets for the LP bot to quote.
 */

import config from '../config/index.js';
import logger from '../utils/logger.js';

const REWARDS_URL = 'https://polymarket.com/api/rewards/markets';
const GAMMA_URL = config.gammaHost;

/**
 * Fetch all markets with active liquidity rewards
 */
export async function fetchRewardMarkets() {
    for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, 5000 * attempt));
        const resp = await fetch(REWARDS_URL, {
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(15000),
        });
        if (resp.status === 429) {
            logger.warn(`LP SCANNER: rate limited, retry ${attempt + 1}/3...`);
            continue;
        }
        if (!resp.ok) throw new Error(`rewards API ${resp.status}`);
        const data = await resp.json();
        return data.data || data;
    }
    throw new Error('rewards API rate limited after 3 retries');
}

/**
 * Fetch orderbook for a token
 */
async function fetchOrderbook(tokenId) {
    try {
        const resp = await fetch(`${config.clobHost}/book?token_id=${tokenId}`, {
            signal: AbortSignal.timeout(8000),
        });
        if (!resp.ok) return null;
        const book = await resp.json();
        const bids = book.bids || [];
        const asks = book.asks || [];
        const bestBid = bids.length > 0 ? parseFloat(bids[0].price) : 0;
        const bestAsk = asks.length > 0 ? parseFloat(asks[0].price) : 1;
        const bidDepth = bids.reduce((s, b) => s + parseFloat(b.size) * parseFloat(b.price), 0);
        const askDepth = asks.reduce((s, a) => s + parseFloat(a.size) * parseFloat(a.price), 0);
        return { bestBid, bestAsk, midpoint: (bestBid + bestAsk) / 2, bidDepth, askDepth, bids, asks };
    } catch { return null; }
}

/**
 * Score and rank markets for LP suitability
 *
 * opts:
 *   minDailyReward  — minimum $/day reward (default 1.0)
 *   minSize         — require market's min_size >= this (0 = no filter; use 200 for large markets)
 *   maxOrderBudget  — skip markets where minSize × yesPrice > this USD (default 200)
 *   priceMin/Max    — YES price range filter
 *   maxMarkets      — how many targets to return
 */
/**
 * Compute liquidity score from orderbook spread and 24h volume.
 * Higher = more liquid = better for LP (easier to exit inventory).
 */
export function liquidityScore(spread, vol24h) {
    if (!Number.isFinite(spread) || spread < 0) spread = 1;
    if (!Number.isFinite(vol24h) || vol24h < 0) vol24h = 0;
    return (1 / (spread + 0.01)) * Math.log(vol24h + 1);
}

export async function scanForTargets(opts = {}) {
    const {
        minDailyReward = 1.0,
        minSize = 0,
        maxOrderBudget = 200,
        priceMin = 0.15,
        priceMax = 0.85,
        maxMarkets = 8,
        maxSpreadFilter = 0.05,   // hard filter: skip if YES spread > this
        minVolume = 10000,        // hard filter: skip if 24h volume < this USD
    } = opts;

    const markets = await fetchRewardMarkets();
    logger.info(`LP SCANNER: fetched ${markets.length} reward markets`);

    const candidates = [];

    for (const m of markets) {
        const dailyReward = m.rewards_config?.[0]?.rate_per_day || 0;
        if (dailyReward < minDailyReward) continue;

        const yesToken = m.tokens?.find(t => t.outcome === 'Yes');
        const noToken = m.tokens?.find(t => t.outcome === 'No');
        if (!yesToken || !noToken) continue;

        const yesPrice = yesToken.price;
        if (yesPrice < priceMin || yesPrice > priceMax) continue;

        const maxSpread = m.rewards_max_spread || 0;
        const mktMinSize = m.rewards_min_size || 20;
        const competitiveness = m.market_competitiveness || 0;

        // Filter: market must require at least minSize shares (0 = accept any)
        if (minSize > 0 && mktMinSize < minSize) continue;

        // Filter: skip markets too expensive for our budget
        if (mktMinSize * yesPrice > maxOrderBudget) continue;

        candidates.push({
            conditionId: m.condition_id,
            marketId: m.market_id,
            question: m.question,
            slug: m.market_slug,
            yesTokenId: yesToken.token_id,
            noTokenId: noToken.token_id,
            yesPrice,
            noPrice: noToken.price,
            dailyReward,
            maxSpread: maxSpread / 100, // convert cents to decimal
            minSize: mktMinSize,
            competitiveness,
            vol24h: m.volume_24hr || 0,
        });
    }

    // Pre-score by reward/competition, then enrich top 3x candidates with orderbook data
    for (const c of candidates) {
        c.preScore = c.dailyReward / Math.sqrt(c.competitiveness + 1);
    }
    candidates.sort((a, b) => b.preScore - a.preScore);

    // Enrich top candidates with negRisk, tickSize, and orderbook data
    const enrichPool = candidates.slice(0, maxMarkets * 3); // fetch 3x to allow filtering
    const targets = [];
    for (const t of enrichPool) {
        if (targets.length >= maxMarkets) break;

        // Get negRisk from Gamma (by market ID)
        try {
            const gammaResp = await fetch(
                `${GAMMA_URL}/markets?id=${t.marketId}`,
                { signal: AbortSignal.timeout(8000) }
            );
            if (gammaResp.ok) {
                const gammaData = await gammaResp.json();
                const gm = Array.isArray(gammaData) ? gammaData[0] : gammaData;
                if (gm) {
                    t.negRisk = gm.negRisk ?? gm.neg_risk ?? false;
                    if (gm.endDate) {
                        t.cutoffAt = Math.floor(new Date(gm.endDate).getTime() / 1000);
                    }
                }
            }
        } catch {}

        // Get tickSize from CLOB
        try {
            const tickResp = await fetch(
                `${config.clobHost}/tick-size?token_id=${t.yesTokenId}`,
                { signal: AbortSignal.timeout(5000) }
            );
            if (tickResp.ok) {
                const tickData = await tickResp.json();
                t.tickSize = String(tickData.minimum_tick_size || '0.01');
            }
        } catch {}

        t.negRisk = t.negRisk ?? false;
        t.tickSize = t.tickSize || '0.01';

        // Fetch orderbooks
        const yesBook = await fetchOrderbook(t.yesTokenId);
        const noBook = await fetchOrderbook(t.noTokenId);
        t.yesBook = yesBook;
        t.noBook = noBook;
        if (yesBook) t.midpoint = yesBook.midpoint;

        // Liquidity hard filters
        const yesSpread = yesBook ? (yesBook.bestAsk - yesBook.bestBid) : 1;
        if (maxSpreadFilter > 0 && yesSpread > maxSpreadFilter) {
            logger.info(`LP SCANNER: skip ${t.question?.slice(0, 40)} — spread ${yesSpread.toFixed(2)} > ${maxSpreadFilter}`);
            continue;
        }
        if (minVolume > 0 && t.vol24h < minVolume) {
            logger.info(`LP SCANNER: skip ${t.question?.slice(0, 40)} — vol $${t.vol24h.toFixed(0)} < $${minVolume}`);
            continue;
        }

        // Final score: reward/competition × liquidity
        t.liqScore = liquidityScore(yesSpread, t.vol24h);
        t.score = t.preScore * t.liqScore;
        targets.push(t);
    }

    // Re-sort by final score (liquidity-weighted)
    targets.sort((a, b) => b.score - a.score);

    logger.info(`LP SCANNER: ${candidates.length} candidates → ${enrichPool.length} enriched → ${targets.length} targets`);
    return targets;
}
