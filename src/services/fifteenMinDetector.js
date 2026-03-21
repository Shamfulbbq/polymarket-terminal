/**
 * fifteenMinDetector.js
 * Detects upcoming 15-minute markets for tailsweep.
 * Same pattern as sniperDetector but with 900s slot intervals.
 *
 * Slug format: {asset}-updown-15m-{eventStartTimestamp}
 */

import config from '../config/index.js';
import logger from '../utils/logger.js';

const SLOT_SEC = 15 * 60; // 900 seconds
const POLL_INTERVAL = 30_000; // check every 30s

let pollTimer  = null;
let onMarketCb = null;
const seenKeys = new Set();

function currentSlot() {
    return Math.floor(Date.now() / 1000 / SLOT_SEC) * SLOT_SEC;
}

async function fetchBySlug(asset, slotTimestamp) {
    const slug = `${asset}-updown-15m-${slotTimestamp}`;
    try {
        const resp = await fetch(`${config.gammaHost}/markets/slug/${slug}`, {
            signal: AbortSignal.timeout(8000),
        });
        if (!resp.ok) return null;
        const data = await resp.json();
        return data?.conditionId ? data : null;
    } catch {
        return null;
    }
}

function extractMarketData(market, asset, slotTimestamp) {
    const conditionId = market.conditionId || market.condition_id || '';
    if (!conditionId) return null;

    let tokenIds = market.clobTokenIds ?? market.clob_token_ids;
    if (typeof tokenIds === 'string') {
        try { tokenIds = JSON.parse(tokenIds); } catch { tokenIds = null; }
    }

    let yesTokenId, noTokenId;
    if (Array.isArray(tokenIds) && tokenIds.length >= 2) {
        [yesTokenId, noTokenId] = tokenIds;
    } else if (Array.isArray(market.tokens) && market.tokens.length >= 2) {
        yesTokenId = market.tokens[0]?.token_id ?? market.tokens[0]?.tokenId;
        noTokenId  = market.tokens[1]?.token_id ?? market.tokens[1]?.tokenId;
    }

    if (!yesTokenId || !noTokenId) return null;

    return {
        asset,
        conditionId,
        question:       market.question || market.title || '',
        endTime:        market.endDate  || market.end_date_iso || market.endDateIso,
        yesTokenId:     String(yesTokenId),
        noTokenId:      String(noTokenId),
        negRisk:        market.negRisk  ?? market.neg_risk  ?? false,
        tickSize:       String(market.orderPriceMinTickSize ?? market.minimum_tick_size ?? '0.01'),
        slotTimestamp,
        slotDuration:   SLOT_SEC,
    };
}

async function poll() {
    const now = Math.floor(Date.now() / 1000);
    const slot = currentSlot();
    const nextSlotTs = slot + SLOT_SEC;
    const secsLeft = (slot + SLOT_SEC) - now;

    for (const asset of config.tailSweepAssets) {
        // Current slot if enough time left
        if (secsLeft > 60) {
            const key = `${asset}-15m-${slot}`;
            if (!seenKeys.has(key)) {
                const market = await fetchBySlug(asset, slot);
                if (market) {
                    const data = extractMarketData(market, asset, slot);
                    if (data) {
                        seenKeys.add(key);
                        logger.info(`15M-DETECT: ${asset.toUpperCase()} found slot ${slot} (${secsLeft}s left)`);
                        if (onMarketCb) onMarketCb(data);
                    }
                }
            }
        }

        // Next slot (pre-cache)
        const nextKey = `${asset}-15m-${nextSlotTs}`;
        if (!seenKeys.has(nextKey)) {
            const market = await fetchBySlug(asset, nextSlotTs);
            if (market) {
                const data = extractMarketData(market, asset, nextSlotTs);
                if (data) {
                    seenKeys.add(nextKey);
                    const openInSecs = nextSlotTs - now;
                    logger.info(`15M-DETECT: ${asset.toUpperCase()} pre-cached slot ${nextSlotTs} (opens in ${openInSecs}s)`);
                    if (onMarketCb) onMarketCb(data);
                }
            }
        }
    }
}

export function start15mDetector(callback) {
    onMarketCb = callback;
    poll().catch(err => logger.error(`15M-DETECT: poll error — ${err.message}`));
    pollTimer = setInterval(
        () => poll().catch(err => logger.error(`15M-DETECT: poll error — ${err.message}`)),
        POLL_INTERVAL,
    );
    logger.info(`15M-DETECT: started for assets: ${config.tailSweepAssets.join(', ').toUpperCase()}`);
}

export function stop15mDetector() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
