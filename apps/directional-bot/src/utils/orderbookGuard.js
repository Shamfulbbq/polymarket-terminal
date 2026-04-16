/**
 * orderbookGuard.js
 * Defensive validation layer for orderbook data from the Polymarket CLOB API.
 *
 * Three layers:
 *   1. Staleness detection — flags identical consecutive reads
 *   2. Spread sanity check — rejects impossible/degenerate books
 *   3. Circuit breaker — global halt on sustained anomalies
 */

import logger from './logger.js';

// ── State ────────────────────────────────────────────────────────────────────

/** Per-token staleness tracking: tokenId -> { bestBid, bestAsk, bidLiq, askLiq, staleCount } */
const _staleMap = new Map();

/** Rolling anomaly timestamps (across all tokens) */
const _anomalyTimestamps = [];

/** Circuit breaker state */
let _circuitBroken = false;
let _circuitResetTimer = null;
let _lastTripTs = null;

// ── Config ───────────────────────────────────────────────────────────────────

const STALE_WARN_COUNT = 5;
const STALE_REJECT_COUNT = 10;  // 10 identical reads (~2.5 min at 15s polling)
const ANOMALY_WINDOW_MS = 5 * 60 * 1000;   // 5 minutes
const ANOMALY_THRESHOLD = 10;               // 10 anomalies in window → trip
const CIRCUIT_HALT_MS = 2 * 60 * 1000;     // 2-minute cooldown

// ── Helpers ──────────────────────────────────────────────────────────────────

function pruneAnomalies() {
    const cutoff = Date.now() - ANOMALY_WINDOW_MS;
    while (_anomalyTimestamps.length > 0 && _anomalyTimestamps[0] < cutoff) {
        _anomalyTimestamps.shift();
    }
}

function recordAnomaly(reason, tokenId) {
    _anomalyTimestamps.push(Date.now());
    pruneAnomalies();

    if (_anomalyTimestamps.length >= ANOMALY_THRESHOLD && !_circuitBroken) {
        _circuitBroken = true;
        _lastTripTs = new Date().toISOString();
        logger.error(`GUARD: circuit breaker TRIPPED — ${_anomalyTimestamps.length} anomalies in 5m window — halting for 2m`);

        if (_circuitResetTimer) clearTimeout(_circuitResetTimer);
        _circuitResetTimer = setTimeout(() => {
            _circuitBroken = false;
            _circuitResetTimer = null;
            logger.info('GUARD: circuit breaker RESET — resuming normal operation');
        }, CIRCUIT_HALT_MS);
    }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Validate an orderbook returned by fetchOrderbook / fetchBook.
 * Returns the book if valid, null if invalid/stale.
 *
 * Accepts books with either shape:
 *   { bestBid, bestAsk, spread, askLiquidity, bidLiquidity }  (tailSweep/directional)
 *   { bestBid, bestAsk, midpoint, bids, asks }                (lpExecutor)
 */
export function validateOrderbook(tokenId, book) {
    if (!book) return null;

    const bestBid = book.bestBid ?? 0;
    const bestAsk = book.bestAsk ?? 1;
    const spread = bestAsk - bestBid;

    // ── Layer 1: Spread sanity check ─────────────────────────────────────
    if (spread === 0) {
        logger.warn(`GUARD: spread=0 (bid===ask=${bestBid}) for ${tokenId.slice(-8)} — rejecting`);
        recordAnomaly('spread_zero', tokenId);
        return null;
    }
    // Dangerous anomalies — count toward circuit breaker
    if (bestBid > bestAsk) {
        logger.warn(`GUARD: crossed book bid=${bestBid} > ask=${bestAsk} for ${tokenId.slice(-8)} — rejecting`);
        recordAnomaly('crossed_book', tokenId);
        return null;
    }
    if (bestBid < 0 || bestAsk > 1) {
        logger.warn(`GUARD: out-of-range bid=${bestBid} ask=${bestAsk} for ${tokenId.slice(-8)} — rejecting`);
        recordAnomaly('out_of_range', tokenId);
        return null;
    }
    // Non-dangerous — reject but don't count toward circuit breaker
    // (empty/wide books are normal on illiquid prediction markets)
    if (bestBid === 0 && bestAsk === 1) {
        return null; // silent reject — empty book
    }
    if (spread > 0.90) {
        return null; // silent reject — wide spread, not a feed failure
    }

    // ── Layer 2: Staleness detection ─────────────────────────────────────
    const bidLiq = book.bidLiquidity ?? (book.bids ? book.bids.reduce((s, b) => s + parseFloat(b.size || 0), 0) : 0);
    const askLiq = book.askLiquidity ?? (book.asks ? book.asks.reduce((s, a) => s + parseFloat(a.size || 0), 0) : 0);

    const prev = _staleMap.get(tokenId);
    if (prev &&
        prev.bestBid === bestBid &&
        prev.bestAsk === bestAsk &&
        prev.bidLiq === bidLiq &&
        prev.askLiq === askLiq) {
        prev.staleCount++;
        if (prev.staleCount === STALE_WARN_COUNT) {
            logger.warn(`GUARD: stale orderbook (${prev.staleCount}x identical) for ${tokenId.slice(-8)}`);
        }
        if (prev.staleCount >= STALE_REJECT_COUNT) {
            logger.warn(`GUARD: rejecting stale orderbook (${prev.staleCount}x identical) for ${tokenId.slice(-8)}`);
            recordAnomaly('stale', tokenId);
            return null;
        }
    } else {
        _staleMap.set(tokenId, { bestBid, bestAsk, bidLiq, askLiq, staleCount: 1 });
    }

    return book;
}

/**
 * Returns true if the circuit breaker is active (global halt).
 */
export function isCircuitBroken() {
    return _circuitBroken;
}

/**
 * Returns current guard statistics.
 */
export function getGuardStats() {
    pruneAnomalies();
    let staleCount = 0;
    for (const entry of _staleMap.values()) {
        if (entry.staleCount >= STALE_WARN_COUNT) staleCount++;
    }
    return {
        staleCount,
        anomalyCount: _anomalyTimestamps.length,
        circuitBroken: _circuitBroken,
        lastTrip: _lastTripTs,
    };
}
