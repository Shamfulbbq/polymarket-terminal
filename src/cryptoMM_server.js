/**
 * cryptoMM_server.js
 * Execution Engine for the Microservices architecture.
 * Exposes a local HTTP server that Python can hit to schedule markets.
 */

import express from 'express';
import config from './config/index.js';
import logger from './utils/logger.js';
import { initClientWithKeys } from './services/client.js';
import { scheduleMarket, getMMStats, cancelAllOrders, checkFills, CMM_ASSETS } from './services/cryptoMMExecutor.js';

if (CMM_ASSETS.length === 0) {
    console.error('CMM_ASSETS is empty. Set e.g. CMM_ASSETS=btc,eth,sol in .env');
    process.exit(1);
}

const CMM_PRIVATE_KEY = config.tailSweepPrivateKey || config.privateKey;
const CMM_PROXY_WALLET = config.tailSweepProxyWallet || config.proxyWallet;

if (!CMM_PRIVATE_KEY || !CMM_PROXY_WALLET) {
    console.error('Missing wallet keys. Set TAILSWEEP_PRIVATE_KEY + TAILSWEEP_PROXY_WALLET_ADDRESS (or PRIVATE_KEY + PROXY_WALLET_ADDRESS) in .env');
    process.exit(1);
}

const app = express();
app.use(express.json());

// ── API Routes ──────────────────────────────────────────────────────────────

app.post('/api/schedule', (req, res) => {
    const market = req.body.market;
    if (!market || !market.asset) {
        return res.status(400).json({ error: 'Invalid market data' });
    }
    
    // Safety check
    const asset = market.asset.toLowerCase();
    if (!CMM_ASSETS.includes(asset)) {
        return res.status(400).json({ error: 'Asset not in CMM_ASSETS' });
    }
    
    logger.info(`CMM_SERVER: Received schedule request for ${asset.toUpperCase()}`);
    scheduleMarket(market);
    res.json({ status: 'scheduled' });
});

app.post('/api/cancel-all', async (req, res) => {
    logger.info('CMM_SERVER: Received cancel all request');
    await cancelAllOrders();
    res.json({ status: 'cancelled' });
});

app.get('/api/stats', (req, res) => {
    res.json(getMMStats());
});

// ── Startup ─────────────────────────────────────────────────────────────────

async function startServer() {
    try {
        await initClientWithKeys(CMM_PRIVATE_KEY, CMM_PROXY_WALLET);
        logger.info('CMM_SERVER: CLOB Client initialized');
        
        if (!config.dryRun) {
            try {
                const { getClient } = await import('./services/client.js');
                await getClient().cancelAll();
                logger.info('CMM_SERVER: Stale orders cleared');
            } catch (err) {
                logger.warn(`CMM_SERVER: cancelAll failed — ${err.message}`);
            }
        }
    } catch (err) {
        logger.error(`CMM_SERVER: Client init error: ${err.message}`);
        process.exit(1);
    }

    // Start fill checking loop
    setInterval(async () => {
        try {
            await checkFills();
        } catch (err) {
            logger.warn(`CMM_SERVER: fill check error — ${err.message}`);
        }
    }, 15_000);

    const port = process.env.CMM_PORT || 3000;
    app.listen(port, () => {
        logger.info(`CMM_SERVER: Execution HTTP Engine listening on port ${port}`);
        logger.info(`Mode: ${config.dryRun ? 'PAPER' : 'LIVE'}`);
    });
}

// Graceful shutdown
async function shutdown() {
    logger.warn('CMM_SERVER: shutting down...');
    await cancelAllOrders();
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

startServer();
