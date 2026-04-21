
module.exports = {
    apps: [
        {
            name: 'directional',
            script: 'src/index.js',
            cwd: '/home/ubuntu/polymarket-terminal/apps/directional-bot',
            env: {
                NODE_ENV: 'production',
                DRY_RUN: 'false',
                
                // Asset & Mode
                DIRECTIONAL_ASSET: 'btc,eth',
                DIRECTIONAL_TIMEFRAMES: '15m',
                
                // Signal Selection
                DIRECTIONAL_BTC_SIGNAL: 'preMomentumComposite',
                DIRECTIONAL_ETH_SIGNAL: 'orderFlowComposite',
                
                // Signal Config
                DIRECTIONAL_SIGNAL_MINUTES: '3',
                DIRECTIONAL_1H_SIGNAL_MINUTES: '15',
                
                // Execution Limits
                DIRECTIONAL_SHARES: '10',
                DIRECTIONAL_MIN_CONFIDENCE: '0.50',
                DIRECTIONAL_ENTRY_PRICE: '0.65',
                DIRECTIONAL_MAX_ENTRY_PRICE: '0.75',
                
                // Safety
                DIRECTIONAL_DAILY_LOSS_LIMIT: '50',
                DIRECTIONAL_BLOCKED_HOURS: '0,3,8,12,14,15,19,22',
                DIRECTIONAL_NO_TUI: 'true'
            }
        }
    ]
};
