import { readState, writeState } from './state.js';

const SIM_FILE = 'sim_stats.json';

function defaultStats() {
    return {
        startTime: new Date().toISOString(),
        totalBuys: 0,
        totalResolved: 0,
        wins: 0,
        losses: 0,
        closedPnl: 0,
        closedPositions: [],
    };
}

export function getSimStats() {
    return readState(SIM_FILE, defaultStats());
}

export function recordSimBuy() {
    const stats = getSimStats();
    stats.totalBuys = (stats.totalBuys || 0) + 1;
    writeState(SIM_FILE, stats);
}

/**
 * Record result of a resolved simulation position
 * @param {Object} position - the position object
 * @param {'WIN'|'LOSS'} result
 * @param {number} pnl  - realized P&L in USDC
 * @param {number} returned - USDC returned
 */
export function recordSimResult(position, result, pnl, returned) {
    const stats = getSimStats();
    stats.totalResolved = (stats.totalResolved || 0) + 1;
    if (result === 'WIN') stats.wins = (stats.wins || 0) + 1;
    else stats.losses = (stats.losses || 0) + 1;
    stats.closedPnl = ((stats.closedPnl || 0) + pnl);

    stats.closedPositions = stats.closedPositions || [];
    stats.closedPositions.push({
        market: position.market,
        outcome: position.outcome,
        totalCost: position.totalCost,
        shares: position.shares,
        returned,
        pnl,
        result,
        closedAt: new Date().toISOString(),
    });

    // Keep last 100 entries
    if (stats.closedPositions.length > 100) {
        stats.closedPositions = stats.closedPositions.slice(-100);
    }

    writeState(SIM_FILE, stats);
}

export function resetSimStats() {
    writeState(SIM_FILE, defaultStats());
}
