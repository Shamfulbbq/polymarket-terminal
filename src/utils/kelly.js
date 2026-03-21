/**
 * kelly.js
 * Half-Kelly position sizing for binary outcome markets.
 *
 * Kelly fraction = (p * b - q) / b
 *   where p = win probability, q = 1-p, b = net odds (payout / stake)
 *
 * For a binary market bought at price `entry`:
 *   stake = entry per share, payout = 1.0 per share on win
 *   b = (1 - entry) / entry
 *
 * We use half-Kelly (f/2) for reduced variance, standard in practice.
 */

/**
 * Calculate Kelly-optimal shares for a tailsweep trade.
 *
 * @param {object} params
 * @param {number} params.winRate    - Rolling win rate (0-1)
 * @param {number} params.entryPrice - Ask price to buy at (0-1)
 * @param {number} params.balance    - Available USDC balance
 * @param {number} params.minShares  - Minimum shares (floor, e.g. 1)
 * @param {number} params.maxShares  - Hard cap (e.g. 20)
 * @param {number} params.totalTrades - Total resolved trades (for min sample check)
 * @param {number} params.minTrades  - Minimum trades before Kelly activates (e.g. 30)
 * @returns {number} shares to buy (integer, clamped to [minShares, maxShares])
 */
export function kellyShares({ winRate, entryPrice, balance, minShares = 1, maxShares = 20, totalTrades = 0, minTrades = 30 }) {
    // Guard: not enough data — return minimum
    if (totalTrades < minTrades) return minShares;

    // Guard: invalid inputs
    if (!Number.isFinite(winRate) || !Number.isFinite(entryPrice)) return minShares;
    if (winRate <= 0 || winRate >= 1) return minShares;
    if (entryPrice <= 0 || entryPrice >= 1) return minShares;
    if (balance <= 0) return 0;

    const p = winRate;
    const q = 1 - p;
    const b = (1 - entryPrice) / entryPrice; // net odds

    // Kelly fraction
    const f = (p * b - q) / b;

    // No edge — don't bet
    if (f <= 0) return 0;

    // Half-Kelly for reduced variance
    const halfF = f / 2;

    // Convert fraction of balance to shares
    const kellyDollars = halfF * balance;
    const rawShares = kellyDollars / entryPrice;

    // Clamp to [minShares, maxShares]
    const clamped = Math.max(minShares, Math.min(maxShares, Math.floor(rawShares)));

    return clamped;
}
