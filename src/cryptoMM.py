"""
cryptoMM.py
Entry point for the Crypto Market Maker bot.
Posts two-sided quotes on Polymarket 5-minute BTC/ETH/SOL markets
to earn maker rebates + liquidity rewards.

Run with: python -m src.cryptoMM         (live)
          DRY_RUN=true python -m src.cryptoMM  (paper trading with $1000 virtual balance)
"""

import os
import sys
import signal
import asyncio
import datetime as dt

from src.config.index import config
from src.utils.logger import logger
from src.services.client import init_client_with_keys, get_client
from src.services.binanceFeed import start_binance_feed, stop_binance_feed, get_binance_feed_status
from src.services.sniperDetector import start_sniper_detector, stop_sniper_detector
from src.services.cryptoTimeframeDetector import start_timeframe_detector, stop_timeframe_detector
from src.services.cryptoMMExecutor import (
    schedule_market, get_mm_stats, cancel_all_orders,
    is_daily_loss_hit, check_fills, CMM_ASSETS
)
from src.services.telegram import send_cmm_report, ENABLED as TELEGRAM_ENABLED

# ── Market handler ──────────────────────────────────────────────────────────

def handle_new_market(market):
    asset = market.get('asset', '').lower()
    if asset not in CMM_ASSETS:
        return
    schedule_market(market)

# ── Status logging ──────────────────────────────────────────────────────────

def log_status():
    stats = get_mm_stats()
    feed = get_binance_feed_status()
    mode = "PAPER" if config.get('dryRun') else "LIVE"
    feed_status = 'OK' if feed.get('status') == 'connected' else feed.get('status')

    last_price = feed.get('lastPrice')
    price_str = f"${last_price:,}" if last_price else "N/A"

    daily_pnl = stats.get('dailyPnl', 0)
    if daily_pnl >= 0:
        daily_pnl_str = f"+${daily_pnl:.2f}"
    else:
        daily_pnl_str = f"-${abs(daily_pnl):.2f}"

    loss_limit = " [LOSS LIMIT HIT]" if is_daily_loss_hit() else ""
    daily_reward = stats.get('dailyRewardEstimate', 0)

    logger.info(
        f"CMM [{mode}] | active={stats.get('activeMarkets', 0)} pending={stats.get('pendingMarkets', 0)} | "
        f"fills={stats.get('fills', 0)} W={stats.get('wins', 0)} L={stats.get('losses', 0)} | "
        f"daily={daily_pnl_str}{loss_limit} | "
        f"rewards~${daily_reward:.2f} | "
        f"feed={feed_status} BTC={price_str}"
    )

# ── Graceful shutdown ───────────────────────────────────────────────────────

_shutting_down = False

async def shutdown(sig):
    global _shutting_down
    if _shutting_down:
        return
    _shutting_down = True

    logger.warning("CMM: shutting down...")
    stop_sniper_detector()
    stop_timeframe_detector()
    stop_binance_feed()
    await cancel_all_orders()

    stats = get_mm_stats()
    daily_pnl = stats.get('dailyPnl', 0)
    daily_pnl_str = f"+${daily_pnl:.2f}" if daily_pnl >= 0 else f"-${abs(daily_pnl):.2f}"
    logger.info(f"CMM: final stats — fills={stats.get('fills', 0)} W={stats.get('wins', 0)} L={stats.get('losses', 0)} daily={daily_pnl_str}")

    tasks = [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)

# ── Main ────────────────────────────────────────────────────────────────────

async def main():
    # ── Validate ────────────────────────────────────────────────────────
    if not CMM_ASSETS:
        logger.error("CMM_ASSETS is empty. Set e.g. CMM_ASSETS=btc,eth,sol in .env")
        sys.exit(1)

    cmm_private_key = config.get('tailSweepPrivateKey') or config.get('privateKey')
    cmm_proxy_wallet = config.get('tailSweepProxyWallet') or config.get('proxyWallet')

    if not cmm_private_key or not cmm_proxy_wallet:
        logger.error(
            "Missing wallet keys. Set TAILSWEEP_PRIVATE_KEY + TAILSWEEP_PROXY_WALLET_ADDRESS "
            "(or PRIVATE_KEY + PROXY_WALLET_ADDRESS) in .env"
        )
        sys.exit(1)

    # ── Init CLOB client ────────────────────────────────────────────────
    try:
        await init_client_with_keys(cmm_private_key, cmm_proxy_wallet)
    except Exception as err:
        logger.error(f"CMM: Client init error: {err}")
        sys.exit(1)

    # ── Register signal handlers ────────────────────────────────────────
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, lambda s=sig: asyncio.create_task(shutdown(s)))

    # ── Start ───────────────────────────────────────────────────────────
    cmm_timeframes_env = os.environ.get('CMM_TIMEFRAMES', '5m')
    cmm_timeframes = [s.strip().lower() for s in cmm_timeframes_env.split(',') if s.strip()]
    has_5m = '5m' in cmm_timeframes
    long_tfs = [tf for tf in cmm_timeframes if tf != '5m']

    mode = "PAPER ($1000 virtual)" if config.get('dryRun') else "LIVE"
    logger.info(f"CMM starting — {mode}")

    assets_str = ", ".join(CMM_ASSETS).upper()
    tfs_str = ", ".join(cmm_timeframes)
    spread = os.environ.get('CMM_SPREAD', '0.04')
    shares = os.environ.get('CMM_SHARES', '20')
    max_loss = os.environ.get('CMM_MAX_DAILY_LOSS', '50')
    logger.info(f"Assets: {assets_str} | Timeframes: {tfs_str} | Spread: {spread} | Shares: {shares} | Max daily loss: ${max_loss}")

    # Cancel any stale open orders from previous sessions
    if not config.get('dryRun'):
        try:
            client = get_client()
            await client.cancel_all()
            logger.info("CMM: startup — stale orders cleared")
        except Exception as err:
            logger.warning(f"CMM: startup cancelAll failed — {err}")

    # Start Binance feed for signal data
    start_binance_feed()

    # 5-minute markets
    if has_5m:
        orig_assets = config.get('sniperAssets', [])
        config['sniperAssets'] = list(set(orig_assets + CMM_ASSETS))
        start_sniper_detector(handle_new_market)
        logger.info("CMM: 5m detector started")

    # 1H+ markets
    if long_tfs:
        start_timeframe_detector(long_tfs, CMM_ASSETS, handle_new_market)
        logger.info(f"CMM: timeframe detector started — {', '.join(long_tfs)}")

    # Fill detection every 15 seconds
    async def fill_loop():
        while True:
            await asyncio.sleep(15)
            try:
                await check_fills()
            except Exception as err:
                logger.warning(f"CMM: fill check error — {err}")

    # Status logging every 60 seconds
    async def status_loop():
        while True:
            await asyncio.sleep(60)
            log_status()

    log_status()
    asyncio.create_task(fill_loop())
    asyncio.create_task(status_loop())

    # Telegram report 3x/day at 00:00, 08:00, 16:00 UTC
    if TELEGRAM_ENABLED:
        async def telegram_loop():
            while True:
                now = dt.datetime.now(dt.timezone.utc)
                h = now.hour
                next_hour = next((t for t in [0, 8, 16] if t > h), 24)

                next_time = now.replace(hour=next_hour % 24, minute=0, second=0, microsecond=0)
                if next_hour == 24:
                    next_time += dt.timedelta(days=1)

                wait_sec = (next_time - now).total_seconds()
                await asyncio.sleep(wait_sec)

                try:
                    await send_cmm_report(get_mm_stats(), cmm_timeframes)
                except Exception:
                    pass

        asyncio.create_task(telegram_loop())
        logger.info("CMM: Telegram reports enabled — next at next 00/08/16 UTC boundary")

    logger.info("CMM: waiting for markets...")

    # Keep alive
    try:
        while True:
            await asyncio.sleep(3600)
    except asyncio.CancelledError:
        pass

if __name__ == '__main__':
    asyncio.run(main())
