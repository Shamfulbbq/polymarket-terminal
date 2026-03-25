"""
cryptoMM_brain.py
Python Data pipeline / Brain engine.
Connects to Binance feeds and Snipe Detectors, and sends HTTP signals
to the node.js execution engine to actually run the trades.
"""

import os
import sys
import signal
import asyncio
import datetime as dt
import requests

from src.config.index import config
from src.utils.logger import logger
from src.services.binanceFeed import start_binance_feed, stop_binance_feed, get_binance_feed_status
from src.services.sniperDetector import start_sniper_detector, stop_sniper_detector
from src.services.cryptoTimeframeDetector import start_timeframe_detector, stop_timeframe_detector
from src.services.telegram import send_cmm_report, ENABLED as TELEGRAM_ENABLED
# Import Python constants just to know what we are watching
from src.services.cryptoMMExecutor import CMM_ASSETS, is_daily_loss_hit

EXEC_SERVER_URL = "http://localhost:3000/api"

# ── Market handler ──────────────────────────────────────────────────────────

def handle_new_market(market):
    asset = market.get('asset', '').lower()
    if asset not in CMM_ASSETS:
        return
        
    logger.info(f"CMM_BRAIN: Detected market for {asset.upper()}, sending to Execution Engine...")
    
    # ── AI LOGIC GOES HERE IN THE FUTURE ──
    # import litellm
    # response = litellm.completion(model="gpt-4", messages=[{"role": "user", "content": "evaluate market..."}])
    # if not response: return
    
    try:
        res = requests.post(f"{EXEC_SERVER_URL}/schedule", json={"market": market}, timeout=5)
        res.raise_for_status()
        logger.info(f"CMM_BRAIN: Successfully handed off to JS Server.")
    except Exception as e:
        logger.error(f"CMM_BRAIN: Failed to reach JS Execution Engine: {e}")

# ── Status logging ──────────────────────────────────────────────────────────

def log_status():
    feed = get_binance_feed_status()
    mode = "PAPER" if config.get('dryRun') else "LIVE"
    feed_status = 'OK' if feed.get('status') == 'connected' else feed.get('status')
    
    last_price = feed.get('lastPrice')
    price_str = f"${last_price:,}" if last_price else "N/A"

    try:
        # Ask JS server for stats
        stats_res = requests.get(f"{EXEC_SERVER_URL}/stats", timeout=3)
        stats_res.raise_for_status()
        stats = stats_res.json()
    except Exception:
        stats = {}
        logger.warning("CMM_BRAIN: Could not fetch stats from Execution Engine. Is it running?")

    daily_pnl = stats.get('dailyPnl', 0)
    if daily_pnl >= 0:
        daily_pnl_str = f"+${daily_pnl:.2f}"
    else:
        daily_pnl_str = f"-${abs(daily_pnl):.2f}"
        
    loss_limit = " [LOSS LIMIT HIT]" if is_daily_loss_hit() else ""
    daily_reward = stats.get('dailyRewardEstimate', 0)

    logger.info(
        f"CMM_BRAIN [{mode}] | active={stats.get('activeMarkets', 0)} pending={stats.get('pendingMarkets', 0)} | "
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

    logger.warning("CMM_BRAIN: shutting down...")
    stop_sniper_detector()
    stop_timeframe_detector()
    stop_binance_feed()
    
    # Optionally tell JS server to cancel orders
    try:
        requests.post(f"{EXEC_SERVER_URL}/cancel-all", timeout=5)
    except Exception:
        pass

    tasks = [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)

# ── Main ────────────────────────────────────────────────────────────────────

async def main():
    if not CMM_ASSETS:
        logger.error("CMM_ASSETS is empty. Set e.g. CMM_ASSETS=btc,eth,sol in .env")
        sys.exit(1)

    cmm_timeframes_env = os.environ.get('CMM_TIMEFRAMES', '5m')
    cmm_timeframes = [s.strip().lower() for s in cmm_timeframes_env.split(',') if s.strip()]
    has_5m = '5m' in cmm_timeframes
    long_tfs = [tf for tf in cmm_timeframes if tf != '5m']

    mode = "PAPER ($1000 virtual)" if config.get('dryRun') else "LIVE"
    logger.info(f"CMM_BRAIN starting — {mode}")
    
    assets_str = ", ".join(CMM_ASSETS).upper()
    logger.info(f"Watching Assets: {assets_str} | Timeframes: {', '.join(cmm_timeframes)}")

    start_binance_feed()

    if has_5m:
        orig_assets = config.get('sniperAssets', [])
        config['sniperAssets'] = list(set(orig_assets + CMM_ASSETS))
        start_sniper_detector(handle_new_market)
        logger.info("CMM_BRAIN: 5m detector started")

    if long_tfs:
        start_timeframe_detector(long_tfs, CMM_ASSETS, handle_new_market)
        logger.info(f"CMM_BRAIN: timeframe detector started — {', '.join(long_tfs)}")

    async def status_loop():
        while True:
            await asyncio.sleep(60)
            log_status()

    # Give a short delay to ensure JS server has started if they are launched together
    await asyncio.sleep(2)
    log_status()
    asyncio.create_task(status_loop())

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
                    stats_res = requests.get(f"{EXEC_SERVER_URL}/stats", timeout=5)
                    stats = stats_res.json() if stats_res.status_code == 200 else {}
                    await send_cmm_report(stats, cmm_timeframes)
                except Exception:
                    pass

        asyncio.create_task(telegram_loop())
        logger.info("CMM_BRAIN: Telegram reports enabled — next at next 00/08/16 UTC boundary")

    logger.info("CMM_BRAIN: connected and waiting for markets to send to Execution Engine...")
    
    # Register signal handlers
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, lambda s=sig: asyncio.create_task(shutdown(s)))

    try:
        while True:
            await asyncio.sleep(3600)
    except asyncio.CancelledError:
        pass

if __name__ == '__main__':
    asyncio.run(main())
