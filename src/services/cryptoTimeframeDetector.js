/**
 * cryptoTimeframeDetector.js
 * Detects upcoming crypto markets at ANY timeframe (1H, 4H, daily, weekly).
 * Generalizes the fifteenMinDetector pattern for longer durations.
 *
 * Slug format: {asset}-updown-{label}-{slotTimestamp}
 * where label = '1h', '4h', 'daily', 'weekly'
 */

import config from '../config/index.js';
import logger from '../utils/logger.js';

const TIMEFRAMES = {
    '1h':     { slotSec: 3600,        label: '1h',     pollMs: 60_000 },
    '4h':     { slotSec: 4 * 3600,    label: '4h',     pollMs: 120_000 },
    'daily':  { slotSec: 24 * 3600,   label: 'daily',  pollMs: 300_000 },
    'weekly': { slotSec: 7 * 24 * 3600, label: 'weekly', pollMs: 600_000 },
};

let pollTimers = [];
let onMarketCb = null;
const seenKeys = new Set();

function currentSlot(slotSec) {
    return Math.floor(Date.now() / 1000 / slotSec) * slotSec;
}

async function fetchBySlug(asset, label, slotTimestamp) {
    const slug = `${asset}-updown-${label}-${slotTimestamp}`;
    try {
        const resp = await fetch(`${config.gammaHost}/markets/slug/${slug}`, {
            signal: AbortSignal.timeout(10000),
        });
        if (!resp.ok) return null;
        const data = await resp.json();
        return data?.conditionId ? data : null;
    } catch { return null; }
}

function extractMarketData(market, asset, slotTimestamp, slotSec) {
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
        question:     market.question || market.title || '',
        endTime:      market.endDate  || market.end_date_iso || market.endDateIso,
        yesTokenId:   String(yesTokenId),
        noTokenId:    String(noTokenId),
        negRisk:      market.negRisk  ?? market.neg_risk  ?? false,
        tickSize:     String(market.orderPriceMinTickSize ?? market.minimum_tick_size ?? '0.01'),
        slotTimestamp,
        slotDuration: slotSec,
    };
}

async function pollTimeframe(tfKey, assets) {
    const tf = TIMEFRAMES[tfKey];
    if (!tf) return;

    const now = Math.floor(Date.now() / 1000);
    const slot = currentSlot(tf.slotSec);
    const nextSlot = slot + tf.slotSec;
    const secsLeft = (slot + tf.slotSec) - now;

    for (const asset of assets) {
        // Current slot if enough time left
        if (secsLeft > 120) {
            const key = `${asset}-${tf.label}-${slot}`;
            if (!seenKeys.has(key)) {
                const market = await fetchBySlug(asset, tf.label, slot);
                if (market) {
                    const data = extractMarketData(market, asset, slot, tf.slotSec);
                    if (data) {
                        seenKeys.add(key);
                        logger.info(`TF-DETECT: ${asset.toUpperCase()} ${tf.label} found slot ${slot} (${secsLeft}s left)`);
                        if (onMarketCb) onMarketCb(data);
                    }
                }
            }
        }

        // Next slot (pre-cache)
        const nextKey = `${asset}-${tf.label}-${nextSlot}`;
        if (!seenKeys.has(nextKey)) {
            const market = await fetchBySlug(asset, tf.label, nextSlot);
            if (market) {
                const data = extractMarketData(market, asset, nextSlot, tf.slotSec);
                if (data) {
                    seenKeys.add(nextKey);
                    const openIn = nextSlot - now;
                    logger.info(`TF-DETECT: ${asset.toUpperCase()} ${tf.label} pre-cached slot ${nextSlot} (opens in ${openIn}s)`);
                    if (onMarketCb) onMarketCb(data);
                }
            }
        }
    }
}

/**
 * Start detecting crypto markets for the given timeframes.
 * @param {string[]} timeframes - e.g. ['1h', '4h', 'daily']
 * @param {string[]} assets - e.g. ['btc', 'eth', 'sol']
 * @param {Function} callback - called with market data when detected
 */
export function startTimeframeDetector(timeframes, assets, callback) {
    onMarketCb = callback;

    for (const tfKey of timeframes) {
        const tf = TIMEFRAMES[tfKey];
        if (!tf) {
            logger.warn(`TF-DETECT: unknown timeframe "${tfKey}" — skipping`);
            continue;
        }

        // Poll immediately then on interval
        pollTimeframe(tfKey, assets).catch(err =>
            logger.error(`TF-DETECT: ${tfKey} poll error — ${err.message}`)
        );
        const timer = setInterval(
            () => pollTimeframe(tfKey, assets).catch(err =>
                logger.error(`TF-DETECT: ${tfKey} poll error — ${err.message}`)
            ),
            tf.pollMs,
        );
        pollTimers.push(timer);

        logger.info(`TF-DETECT: ${tfKey} detector started — assets: ${assets.join(', ').toUpperCase()} (poll every ${tf.pollMs / 1000}s)`);
    }
}

export function stopTimeframeDetector() {
    for (const t of pollTimers) clearInterval(t);
    pollTimers = [];
}
