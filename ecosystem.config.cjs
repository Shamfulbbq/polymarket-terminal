/**
 * pm2 ecosystem config
 * Usage: pm2 start ecosystem.config.cjs --only directional
 *        pm2 restart directional --update-env
 *
 * All DIRECTIONAL_* settings live here — never rely on ad-hoc pm2 env overrides.
 */
module.exports = {
    apps: [
        {
            name: 'directional',
            script: 'npm',
            args: 'run directional',
            cwd: '/home/ubuntu/polymarket-terminal',
            env: {
                // ── Core ──────────────────────────────────────────────
                DRY_RUN: 'false',

                // ── Asset(s) to trade — comma-separated ───────────────
                DIRECTIONAL_ASSET: 'btc,eth',

                // ── Signal config ─────────────────────────────────────
                // momentum for BTC, orderFlowComposite for ETH (backtest winners)
                DIRECTIONAL_BTC_SIGNAL: 'momentum',
                DIRECTIONAL_ETH_SIGNAL: 'orderFlowComposite',
                DIRECTIONAL_SIGNAL_MINUTES: '10',
                DIRECTIONAL_1H_SIGNAL_MINUTES: '15',

                // ── Timeframes ────────────────────────────────────────
                DIRECTIONAL_TIMEFRAMES: '15m',

                // ── Entry price & safety caps ─────────────────────────
                // $0.65 avoids the peak fee zone near 50/50 probability
                DIRECTIONAL_ENTRY_PRICE: '0.65',
                DIRECTIONAL_MAX_ENTRY_PRICE: '0.75',

                // ── Kelly Spread sizing ───────────────────────────────
                // maxShares = ceiling; minShares floors at min(5, maxShares)
                DIRECTIONAL_SHARES: '10',

                // ── Confidence gate ───────────────────────────────────
                // Signals below 45% are ignored entirely (lowered from 55% after analysis)
                DIRECTIONAL_MIN_CONFIDENCE: '0.45',

                // ── Risk management ───────────────────────────────────
                DIRECTIONAL_DAILY_LOSS_LIMIT: '50',

                // ── Blocked UTC hours (historically unprofitable) ─────
                DIRECTIONAL_BLOCKED_HOURS: '0,3,8,12,14,15,19,22',
            },
        },
    ],
};
