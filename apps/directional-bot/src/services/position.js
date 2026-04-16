import { readState, writeState } from '../utils/state.js';
import logger from '../utils/logger.js';

const POSITIONS_FILE = 'positions.json';

/**
 * Get all current positions
 * @returns {Object} Map of conditionId -> position data
 */
export function getPositions() {
    return readState(POSITIONS_FILE, {});
}

/**
 * Check if we already have a position for this market (conditionId)
 * @param {string} conditionId
 * @returns {boolean}
 */
export function hasPosition(conditionId) {
    const positions = getPositions();
    return !!positions[conditionId];
}

/**
 * Add a new position after buy is filled
 * @param {Object} params
 * @param {string} params.conditionId - Market condition ID
 * @param {string} params.tokenId - CLOB token ID
 * @param {string} params.market - Market question/title
 * @param {number} params.shares - Number of shares bought
 * @param {number} params.avgBuyPrice - Average buy price
 * @param {number} params.totalCost - Total USDC spent
 * @param {string} params.outcome - YES/NO outcome
 * @param {string} [params.sellOrderId] - Auto-sell order ID if placed
 */
export function addPosition({
    conditionId,
    tokenId,
    market,
    shares,
    avgBuyPrice,
    totalCost,
    outcome,
    sellOrderId,
}) {
    const positions = getPositions();
    positions[conditionId] = {
        conditionId,
        tokenId,
        market,
        shares,
        avgBuyPrice,
        totalCost,
        outcome: outcome || '',
        sellOrderId: sellOrderId || null,
        status: 'open', // open, selling, sold, redeemed
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    writeState(POSITIONS_FILE, positions);
    logger.success(`Position added: ${market} | ${shares} shares @ $${avgBuyPrice}`);
}

/**
 * Update a position
 * @param {string} conditionId
 * @param {Object} updates - Fields to update
 */
export function updatePosition(conditionId, updates) {
    const positions = getPositions();
    if (positions[conditionId]) {
        positions[conditionId] = {
            ...positions[conditionId],
            ...updates,
            updatedAt: new Date().toISOString(),
        };
        writeState(POSITIONS_FILE, positions);
    }
}

/**
 * Remove a position (after sell or redeem)
 * @param {string} conditionId
 */
export function removePosition(conditionId) {
    const positions = getPositions();
    if (positions[conditionId]) {
        const market = positions[conditionId].market;
        delete positions[conditionId];
        writeState(POSITIONS_FILE, positions);
        logger.info(`Position removed: ${market}`);
    }
}

/**
 * Get position by conditionId
 * @param {string} conditionId
 * @returns {Object|null}
 */
export function getPosition(conditionId) {
    const positions = getPositions();
    return positions[conditionId] || null;
}

/**
 * Get all open positions as an array
 * @returns {Array}
 */
export function getOpenPositions() {
    const positions = getPositions();
    return Object.values(positions).filter((p) => p.status === 'open');
}
