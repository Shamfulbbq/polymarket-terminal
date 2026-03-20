import dotenv from 'dotenv';
dotenv.config();

const config = {
  // Wallet
  privateKey: process.env.PRIVATE_KEY,         // EOA private key (for signing only)
  proxyWallet: process.env.PROXY_WALLET_ADDRESS, // Polymarket proxy wallet (deposit USDC here)

  // Polymarket API (optional, auto-derived if empty)
  clobApiKey: process.env.CLOB_API_KEY || '',
  clobApiSecret: process.env.CLOB_API_SECRET || '',
  clobApiPassphrase: process.env.CLOB_API_PASSPHRASE || '',

  // Polymarket endpoints
  clobHost: 'https://clob.polymarket.com',
  gammaHost: 'https://gamma-api.polymarket.com',
  dataHost: 'https://data-api.polymarket.com',
  chainId: 137,

  // Polygon RPC
  polygonRpcUrl: process.env.POLYGON_RPC_URL || 'https://polygon-bor-rpc.publicnode.com',

  // Trader to copy
  traderAddress: process.env.TRADER_ADDRESS,

  // Trade sizing
  sizeMode: process.env.SIZE_MODE || 'percentage', // "percentage" | "balance"
  sizePercent: parseFloat(process.env.SIZE_PERCENT || '50'),
  minTradeSize: parseFloat(process.env.MIN_TRADE_SIZE || '1'),
  maxPositionSize: parseFloat(process.env.MAX_POSITION_SIZE || '10'),

  // Auto sell
  autoSellEnabled: process.env.AUTO_SELL_ENABLED === 'true',
  autoSellProfitPercent: parseFloat(process.env.AUTO_SELL_PROFIT_PERCENT || '10'),

  // Sell mode when copying sell
  sellMode: process.env.SELL_MODE || 'market', // "market" | "limit"

  // Redeem interval (seconds)
  redeemInterval: parseInt(process.env.REDEEM_INTERVAL || '60', 10) * 1000,

  // Dry run
  dryRun: process.env.DRY_RUN === 'true',

  // Retry settings
  maxRetries: 5,
  retryDelay: 3000,

  // ── Market Maker ──────────────────────────────────────────────
  mmAssets:        (process.env.MM_ASSETS || 'btc')
                     .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  mmDuration:      process.env.MM_DURATION || '5m',  // '5m' or '15m'
  mmTradeSize:     parseFloat(process.env.MM_TRADE_SIZE     || '5'),    // USDC per side
  mmSellPrice:     parseFloat(process.env.MM_SELL_PRICE     || '0.60'), // limit sell target
  mmCutLossTime:   parseInt(  process.env.MM_CUT_LOSS_TIME  || '60', 10), // seconds before close
  mmMarketKeyword: process.env.MM_MARKET_KEYWORD            || 'Bitcoin Up or Down',
  mmEntryWindow:   parseInt(  process.env.MM_ENTRY_WINDOW   || '45', 10), // max secs after open
  mmPollInterval:  parseInt(  process.env.MM_POLL_INTERVAL  || '10', 10) * 1000,

  // ── Recovery Buy (after cut-loss) ─────────────────────────────
  // When enabled: after cutting loss, monitor prices for 10s and
  // market-buy the dominant side if it's above threshold and rising/stable.
  mmRecoveryBuy:       process.env.MM_RECOVERY_BUY         === 'true',
  mmRecoveryThreshold: parseFloat(process.env.MM_RECOVERY_THRESHOLD || '0.70'), // min price to qualify
  mmRecoverySize:      parseFloat(process.env.MM_RECOVERY_SIZE      || '0'),    // 0 = use mmTradeSize

  // ── Orderbook Sniper ───────────────────────────────────────────
  // Places tiny GTC limit BUY orders at a very low price on each side
  // of ETH/SOL/XRP 5-minute markets — catches panic dumps near $0.
  sniperAssets: (process.env.SNIPER_ASSETS || 'eth,sol,xrp')
                  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  sniperPrice:  parseFloat(process.env.SNIPER_PRICE  || '0.01'), // $ per share
  sniperShares: parseFloat(process.env.SNIPER_SHARES || '5'),    // shares per side

  // ── Directional Sniper (15m BTC) ────────────────────────────────
  directionalAsset:         (process.env.DIRECTIONAL_ASSET || 'btc').toLowerCase(),
  directionalSignalMinutes: parseInt(process.env.DIRECTIONAL_SIGNAL_MINUTES || '3', 10),
  directionalSignal:        process.env.DIRECTIONAL_SIGNAL || 'composite',
  directionalEntryPrice:    parseFloat(process.env.DIRECTIONAL_ENTRY_PRICE || '0.55'),
  directionalShares:        parseFloat(process.env.DIRECTIONAL_SHARES || '10'),
  directionalMinConfidence: parseFloat(process.env.DIRECTIONAL_MIN_CONFIDENCE || '0'),
  // Comma-separated UTC hours to skip (e.g. "0,3,8,12,14,15,19,22")
  // Derived from outcome analytics — hours with negative PnL in backtest
  directionalBlockedHours: (process.env.DIRECTIONAL_BLOCKED_HOURS || '0,3,8,12,14,15,19,22')
                             .split(',').map(h => parseInt(h.trim(), 10)).filter(h => !isNaN(h)),

  // ── Tail Sweep (5-min late-entry) ──────────────────────────────
  tailSweepAssets: (process.env.TAIL_SWEEP_ASSETS || 'btc,eth,sol')
                     .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  tailSweepThreshold:     parseFloat(process.env.TAIL_SWEEP_THRESHOLD      || '0.90'),
  tailSweepShares:        parseFloat(process.env.TAIL_SWEEP_SHARES         || '10'),
  tailSweepSecondsBefore: parseInt(  process.env.TAIL_SWEEP_SECONDS_BEFORE || '20', 10),
  tailSweepMinLiquidity:  parseFloat(process.env.TAIL_SWEEP_MIN_LIQUIDITY  || '5'),
  tailSweepMaxPrice:      parseFloat(process.env.TAIL_SWEEP_MAX_PRICE      || '0.97'), // skip if ask > this

  // ── Favorite Bias (RN1-style) ───────────────────────────────────
  // Buy the favorite side when price is in [priceMin, priceMax]. No Pinnacle (minimal).
  favoritePriceMin:     parseFloat(process.env.FAVORITE_PRICE_MIN || '0.50'),
  favoritePriceMax:     parseFloat(process.env.FAVORITE_PRICE_MAX || '0.85'),
  favoriteOrderSize:    parseFloat(process.env.FAVORITE_ORDER_SIZE || '5'),   // USDC per order
  favoritePollInterval: parseInt(process.env.FAVORITE_POLL_INTERVAL || '60', 10) * 1000, // ms
  // Comma-separated keywords; event title or tag slug must match one (case-insensitive)
  favoriteKeywords: (process.env.FAVORITE_KEYWORDS || 'football,soccer,EPL,Serie A,La Liga,Ligue 1,win')
                      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
};

// Validation for copy-trade bot
export function validateConfig() {
  const required = ['privateKey', 'proxyWallet', 'traderAddress'];
  const missing = required.filter((key) => !config[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required config: ${missing.join(', ')}. Check your .env file.`);
  }
  if (!['percentage', 'balance'].includes(config.sizeMode)) {
    throw new Error(`Invalid SIZE_MODE: ${config.sizeMode}. Use "percentage" or "balance".`);
  }
  if (!['market', 'limit'].includes(config.sellMode)) {
    throw new Error(`Invalid SELL_MODE: ${config.sellMode}. Use "market" or "limit".`);
  }
}

// Validation for market-maker bot
export function validateMMConfig() {
  const required = ['privateKey', 'proxyWallet'];
  const missing = required.filter((key) => !config[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required config: ${missing.join(', ')}. Check your .env file.`);
  }
  if (config.mmTradeSize <= 0) throw new Error('MM_TRADE_SIZE must be > 0');
  if (config.mmSellPrice <= 0 || config.mmSellPrice >= 1)
    throw new Error('MM_SELL_PRICE must be between 0 and 1');
}

// Validation for favorite-bias bot
export function validateFavoriteConfig() {
  const required = ['privateKey', 'proxyWallet'];
  const missing = required.filter((key) => !config[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required config: ${missing.join(', ')}. Check your .env file.`);
  }
  if (config.favoritePriceMin < 0 || config.favoritePriceMin >= 1)
    throw new Error('FAVORITE_PRICE_MIN must be in [0, 1)');
  if (config.favoritePriceMax <= 0 || config.favoritePriceMax > 1)
    throw new Error('FAVORITE_PRICE_MAX must be in (0, 1]');
  if (config.favoritePriceMin >= config.favoritePriceMax)
    throw new Error('FAVORITE_PRICE_MIN must be < FAVORITE_PRICE_MAX');
  if (config.favoriteOrderSize <= 0)
    throw new Error('FAVORITE_ORDER_SIZE must be > 0');
  if (config.favoriteKeywords.length === 0)
    throw new Error('FAVORITE_KEYWORDS must have at least one keyword.');
}

// Validation for directional sniper bot
export function validateDirectionalConfig() {
  const required = ['privateKey', 'proxyWallet'];
  const missing = required.filter((key) => !config[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required config: ${missing.join(', ')}. Check your .env file.`);
  }
  if (config.directionalEntryPrice <= 0 || config.directionalEntryPrice >= 1)
    throw new Error('DIRECTIONAL_ENTRY_PRICE must be between 0 and 1');
  if (config.directionalShares <= 0)
    throw new Error('DIRECTIONAL_SHARES must be > 0');
  if (config.directionalSignalMinutes < 1 || config.directionalSignalMinutes > 14)
    throw new Error('DIRECTIONAL_SIGNAL_MINUTES must be between 1 and 14');
}

// Validation for tail-sweep bot
export function validateTailSweepConfig() {
  const required = ['privateKey', 'proxyWallet'];
  const missing = required.filter((key) => !config[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required config: ${missing.join(', ')}. Check your .env file.`);
  }
  if (config.tailSweepThreshold <= 0 || config.tailSweepThreshold >= 1)
    throw new Error('TAIL_SWEEP_THRESHOLD must be between 0 and 1');
  if (config.tailSweepShares <= 0)
    throw new Error('TAIL_SWEEP_SHARES must be > 0');
  if (config.tailSweepSecondsBefore < 5 || config.tailSweepSecondsBefore > 60)
    throw new Error('TAIL_SWEEP_SECONDS_BEFORE must be between 5 and 60');
  if (config.tailSweepAssets.length === 0)
    throw new Error('TAIL_SWEEP_ASSETS must have at least one asset');
}

export default config;
