"""
download_data.py
Bulk-download BTCUSDT 1m klines from data.binance.vision (monthly zips).
Much faster than REST API pagination — each zip is ~15MB, one per month.

Usage:
    uv run src/btc5m/download_data.py              # last 12 months
    uv run src/btc5m/download_data.py --months 24  # last 24 months
    uv run src/btc5m/download_data.py --year 2024 --month 3  # specific month

Output: data/btc5m/klines_1m.parquet (all months merged, sorted by openTime)
"""

import argparse
import io
import sys
import zipfile
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
import requests

ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = ROOT / "data" / "btc5m"
DATA_DIR.mkdir(parents=True, exist_ok=True)

BASE_URL = "https://data.binance.vision/data/spot/monthly/klines/BTCUSDT/1m"
KLINE_COLS = [
    "openTime", "open", "high", "low", "close", "volume",
    "closeTime", "quoteVolume", "trades",
    "takerBuyBaseVol", "takerBuyQuoteVol", "ignore",
]
FLOAT_COLS = ["open", "high", "low", "close", "volume", "quoteVolume",
              "takerBuyBaseVol", "takerBuyQuoteVol"]


def month_range(n_months: int) -> list[tuple[int, int]]:
    today = date.today()
    months = []
    for i in range(n_months, 0, -1):
        d = today.replace(day=1) - timedelta(days=1)
        for _ in range(i - 1):
            d = d.replace(day=1) - timedelta(days=1)
        months.append((d.year, d.month))
    return months


def download_month(year: int, month: int) -> pd.DataFrame | None:
    fname = f"BTCUSDT-1m-{year}-{month:02d}.zip"
    url = f"{BASE_URL}/{fname}"
    cache = DATA_DIR / fname

    if cache.exists():
        print(f"  {fname} (cached)")
        with zipfile.ZipFile(cache) as zf:
            csv_name = zf.namelist()[0]
            with zf.open(csv_name) as f:
                return _parse_csv(f)

    print(f"  Downloading {fname}...", end=" ", flush=True)
    try:
        resp = requests.get(url, timeout=60, stream=True)
        if resp.status_code == 404:
            print("not available yet")
            return None
        resp.raise_for_status()
        data = resp.content
        with open(cache, "wb") as f:
            f.write(data)
        print(f"{len(data) // 1024}KB")
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            with zf.open(zf.namelist()[0]) as f:
                return _parse_csv(f)
    except Exception as e:
        print(f"FAILED: {e}")
        return None


def _parse_csv(f) -> pd.DataFrame:
    df = pd.read_csv(f, header=None, names=KLINE_COLS)
    for col in FLOAT_COLS:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df["trades"] = pd.to_numeric(df["trades"], errors="coerce").astype("Int64")
    df = df.drop(columns=["ignore"])
    return df


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--months", type=int, default=12, help="Number of recent months to download")
    parser.add_argument("--year", type=int, help="Specific year (use with --month)")
    parser.add_argument("--month", type=int, help="Specific month (use with --year)")
    args = parser.parse_args()

    if args.year and args.month:
        targets = [(args.year, args.month)]
    else:
        targets = month_range(args.months)

    print(f"Downloading {len(targets)} month(s) of BTCUSDT 1m klines...")
    frames = []
    for year, month in targets:
        df = download_month(year, month)
        if df is not None:
            frames.append(df)

    if not frames:
        print("No data downloaded.")
        sys.exit(1)

    combined = pd.concat(frames, ignore_index=True)
    combined = combined.sort_values("openTime").drop_duplicates("openTime").reset_index(drop=True)

    out = DATA_DIR / "klines_1m.parquet"
    combined.to_parquet(out, index=False)
    print(f"\nSaved {len(combined):,} candles -> {out}")
    import datetime
    t0 = int(combined.openTime.iloc[0]) // 1_000_000
    t1 = int(combined.openTime.iloc[-1]) // 1_000_000
    print(f"Date range: {datetime.datetime.utcfromtimestamp(t0).strftime('%Y-%m-%d')} "
          f"-> {datetime.datetime.utcfromtimestamp(t1).strftime('%Y-%m-%d')}")


if __name__ == "__main__":
    main()
