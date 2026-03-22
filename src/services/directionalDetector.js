/**
 * directionalDetector.js
 * Detects upcoming BTC 15-minute "Up or Down" markets on Polymarket.
 * Adapted from sniperDetector.js with:
 *   - 15-minute slots (900s) instead of 5-minute (300s)
 *   - Slug: btc-updown-15m-{timestamp}
 *   - Single asset (BTC)
 */

import config from '../config/index.js';
import { performance } from 'perf_hooks';
import logger from '../utils/logger.js';

const SLOT_SEC = 15 * 60; // 900 seconds
const MIN_CURRENT_MARKET_SECONDS_LEFT = 60;

let pollTimer  = null;
let onMarketCb = null;
const seenKeys = new Set();
const nextMarketTimers = new Map();

function currentSlot() {
    return Math.floor(Date.now() / 1000 / SLOT_SEC) * SLOT_SEC;
}

function nextSlot() {
    return currentSlot() + SLOT_SEC;
}

async function fetchBySlug(slotTimestamp) {
    const asset = config.directionalAsset;
    const slug = `${asset}-updown-15m-${slotTimestamp}`;
    try {
        const resp = await fetch(`${config.gammaHost}/markets/slug/${slug}`);
        if (!resp.ok) return null;
        const data = await resp.json();
        return data?.conditionId ? data : null;
    } catch {
        return null;
    }
}

function extractMarketData(market) {
    const asset = config.directionalAsset;
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
        eventStartTime: market.eventStartTime || market.event_start_time,
        yesTokenId:     String(yesTokenId),
        noTokenId:      String(noTokenId),
        negRisk:        market.negRisk  ?? market.neg_risk  ?? false,
        tickSize:       String(market.orderPriceMinTickSize ?? market.minimum_tick_size ?? '0.01'),
    };
}

function emitMarket(data, slotTimestamp, slotType) {
    const key = `${data.asset}-${slotTimestamp}`;
    if (seenKeys.has(key)) return;

    seenKeys.add(key);

    if (onMarketCb) {
        onMarketCb({
            ...data,
            slotTimestamp,
            timing: {
                ...data.timing,
                slotType,
                detectorHandoffAt: new Date().toISOString(),
                detectorHandoffPerfMs: performance.now(),
            },
        });
    }
}

function clearNextMarketTimer(key) {
    const timer = nextMarketTimers.get(key);
    if (timer) {
        clearTimeout(timer);
        nextMarketTimers.delete(key);
    }
}

function scheduleNextMarketHandoff(data, slotTimestamp) {
    const key = `${data.asset}-${slotTimestamp}`;
    if (seenKeys.has(key) || nextMarketTimers.has(key)) return;

    const openAtMs = data.eventStartTime
        ? new Date(data.eventStartTime).getTime()
        : slotTimestamp * 1000;
    const delayMs = Math.max(0, openAtMs - Date.now());

    logger.success(
        `DIRECTIONAL: BTC cached "${data.question.slice(0, 40)}" — handoff in ${Math.round(delayMs / 1000)}s`
    );

    const timer = setTimeout(() => {
        nextMarketTimers.delete(key);
        emitMarket(data, slotTimestamp, 'next');
    }, delayMs);

    nextMarketTimers.set(key, timer);
}

async function scheduleSlot(slotTimestamp, isCurrent = false) {
    const asset = config.directionalAsset;
    const key = `${asset}-${slotTimestamp}`;
    if (seenKeys.has(key)) return;

    const market = await fetchBySlug(slotTimestamp);
    if (!market) return;

    const data = extractMarketData(market);
    if (!data) {
        logger.warn(`DIRECTIONAL: skipping slot ${slotTimestamp} — missing token IDs`);
        seenKeys.add(key);
        return;
    }

    const baseData = {
        ...data,
        timing: {
            marketDetectedAt: new Date().toISOString(),
            marketDetectedPerfMs: performance.now(),
            marketOpenAt: data.eventStartTime || new Date(slotTimestamp * 1000).toISOString(),
        },
    };

    if (isCurrent) {
        const endAt = data.endTime ? new Date(data.endTime).getTime() : (slotTimestamp + SLOT_SEC) * 1000;
        const secsLeft = Math.round((endAt - Date.now()) / 1000);
        if (secsLeft < MIN_CURRENT_MARKET_SECONDS_LEFT) {
            return;
        }
        const signalDeadline = config.directionalSignalMinutes * 60;
        if (secsLeft < signalDeadline + 30) {
            logger.info(`DIRECTIONAL: current market only ${secsLeft}s left — not enough for ${config.directionalSignalMinutes}min signal`);
            return;
        }
        logger.success(`DIRECTIONAL: BTC current market active (${secsLeft}s left)`);
        emitMarket(baseData, slotTimestamp, 'current');
    } else {
        scheduleNextMarketHandoff(baseData, slotTimestamp);
    }
}

async function poll() {
    try {
        await Promise.all([
            scheduleSlot(currentSlot(), true),
            scheduleSlot(nextSlot(), false),
        ]);
    } catch (err) {
        logger.error('DIRECTIONAL detector poll error:', err.message);
    }
}

export function startDirectionalDetector(onNewMarket) {
    onMarketCb = onNewMarket;
    seenKeys.clear();
    for (const key of nextMarketTimers.keys()) clearNextMarketTimer(key);

    poll();
    pollTimer = setInterval(poll, config.mmPollInterval);

    const ns = nextSlot();
    const secsUntil = ns - Math.floor(Date.now() / 1000);
    logger.info(`DIRECTIONAL detector started — asset: BTC 15m`);
    logger.info(`Next slot: btc-updown-15m-${ns} (opens in ${secsUntil}s)`);
}

export function stopDirectionalDetector() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
    for (const key of nextMarketTimers.keys()) clearNextMarketTimer(key);
}
