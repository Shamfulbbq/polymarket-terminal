"""
build_dataset.py
Build training dataset for BTC UP/DN 5-min predictor.

For every 5-minute round (aligned to timestamps divisible by 300):
  - Features: last SEQ_LEN (30) 1m candles before round open
  - Label: 1 if close_price[t+5min] > open_price[t], else 0

Output:
  data/btc5m/dataset.parquet  — flat feature table (one row per round)
  data/btc5m/sequences.npy    — (N, SEQ_LEN, num_features) array for TCN
  data/btc5m/labels.npy       — (N,) binary array

Usage:
    uv run src/btc5m/build_dataset.py
"""

from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = ROOT / "data" / "btc5m"
SEQ_LEN = 60       # 60 one-minute candles as input context (1h lookback)
ROUND_SEC = 300    # 5-minute round

# data.binance.vision bulk CSVs use microsecond timestamps (not ms)
TS_SCALE = 1_000_000  # divide openTime by this to get seconds

FEATURE_NAMES = [
    # Per-candle micro features
    "ret",            # (close - open) / open
    "log_vol",        # log(volume + 1)
    "taker_ratio",    # takerBuyBaseVol / volume (order flow direction)
    "hl_range",       # (high - low) / open (volatility proxy)
    "body_ratio",     # abs(close - open) / (high - low + 1e-8)
    # Rolling multi-scale returns (anchored to each candle's close)
    "ret_5",          # 5-candle rolling return
    "ret_15",         # 15-candle rolling return
    "ret_30",         # 30-candle rolling return
    # Volatility regime
    "vol_ratio",      # volume / 30-candle avg volume (relative activity)
    # Time-of-day encoding (same for all candles in a given minute)
    "hour_sin",       # sin(hour * 2pi/24)
    "hour_cos",       # cos(hour * 2pi/24)
    "dow_sin",        # sin(day_of_week * 2pi/7)
    "dow_cos",        # cos(day_of_week * 2pi/7)
]


def _candle_features(df: pd.DataFrame) -> np.ndarray:
    """Compute per-candle features. Returns (N, len(FEATURE_NAMES)) array."""
    open_ = df["open"].values
    close = df["close"].values
    high  = df["high"].values
    low   = df["low"].values
    vol   = df["volume"].values
    taker = df["takerBuyBaseVol"].values
    ts_sec = (df["openTime"].values // TS_SCALE).astype(np.int64)

    ret         = (close - open_) / (open_ + 1e-8)
    log_vol     = np.log1p(vol)
    taker_ratio = taker / (vol + 1e-8)
    hl_range    = (high - low) / (open_ + 1e-8)
    body_ratio  = np.abs(close - open_) / (high - low + 1e-8)

    # Rolling multi-scale returns from close prices
    def rolling_ret(closes, n):
        r = np.zeros(len(closes))
        r[n:] = (closes[n:] - closes[:-n]) / (closes[:-n] + 1e-8)
        return r

    ret_5  = rolling_ret(close, 5)
    ret_15 = rolling_ret(close, 15)
    ret_30 = rolling_ret(close, 30)

    # Relative volume — TRAILING 30-candle moving average (no future leak).
    # Centered convolve (mode="same") uses future candles and would leak.
    csum = np.concatenate([[0.0], np.cumsum(vol)])
    win = np.minimum(np.arange(1, len(vol) + 1), 30)
    vol_ma30 = (csum[1:] - csum[np.maximum(np.arange(len(vol)) - 29, 0)]) / win
    vol_ratio = vol / (vol_ma30 + 1e-8)

    # Time features (UTC)
    hour = (ts_sec % 86400) / 3600
    dow  = (ts_sec // 86400) % 7
    hour_sin = np.sin(hour * 2 * np.pi / 24)
    hour_cos = np.cos(hour * 2 * np.pi / 24)
    dow_sin  = np.sin(dow  * 2 * np.pi / 7)
    dow_cos  = np.cos(dow  * 2 * np.pi / 7)

    return np.stack([
        ret, log_vol, taker_ratio, hl_range, body_ratio,
        ret_5, ret_15, ret_30, vol_ratio,
        hour_sin, hour_cos, dow_sin, dow_cos,
    ], axis=1).astype(np.float32)


def build(df_klines: pd.DataFrame) -> tuple[np.ndarray, np.ndarray, pd.DataFrame]:
    df = df_klines.sort_values("openTime").reset_index(drop=True)

    # Convert microsecond timestamps to seconds, then align to 5-min boundaries
    df["open_sec"] = df["openTime"] // TS_SCALE
    df["round_open"] = (df["open_sec"] // ROUND_SEC) * ROUND_SEC

    feats = _candle_features(df)

    sequences, labels, meta = [], [], []
    rounds = df["round_open"].unique()

    for rt in sorted(rounds):
        # Indices of candles IN this 5-min round (the label window)
        round_mask = df["round_open"] == rt
        round_candles = df[round_mask]
        if len(round_candles) < 5:
            continue

        # Open price = first candle open in round
        open_price = round_candles.iloc[0]["open"]
        # Close price = last candle close in round
        close_price = round_candles.iloc[-1]["close"]
        # Polymarket rule: UP if close >= open (ties resolve UP)
        label = 1 if close_price >= open_price else 0

        # Input sequence = SEQ_LEN candles BEFORE this round
        before = df[df["round_open"] < rt]
        if len(before) < SEQ_LEN:
            continue
        seq_idx = before.index[-SEQ_LEN:]
        seq = feats[seq_idx]

        sequences.append(seq)
        labels.append(label)
        meta.append({
            "round_ts": int(rt),
            "open_price": open_price,
            "close_price": close_price,
            "label": label,
            "pct_move": (close_price - open_price) / open_price,
        })

    X = np.stack(sequences).astype(np.float32)   # (N, SEQ_LEN, num_features)
    y = np.array(labels, dtype=np.int64)
    meta_df = pd.DataFrame(meta)

    return X, y, meta_df


def normalise(X: np.ndarray, train_frac: float = 0.8) -> tuple[np.ndarray, dict]:
    """Per-feature z-score normalisation. Fit on first `train_frac` rows ONLY
    to avoid leaking val-period statistics into training preprocessing.
    """
    split = int(len(X) * train_frac)
    train_flat = X[:split].reshape(-1, X.shape[-1])
    mean = train_flat.mean(axis=0)
    std = train_flat.std(axis=0) + 1e-8
    X_norm = (X - mean) / std
    return X_norm.astype(np.float32), {"mean": mean, "std": std}


def main():
    src = DATA_DIR / "klines_1m.parquet"
    if not src.exists():
        print(f"Missing {src}. Run download_data.py first.")
        return

    print("Loading klines...")
    df = pd.read_parquet(src)
    print(f"  {len(df):,} candles loaded")

    print("Building sequences...")
    X, y, meta = build(df)
    print(f"  {len(X):,} rounds built (UP={y.sum()}, DN={(1-y).sum()})")

    print("Normalising features...")
    X_norm, norm_params = normalise(X)
    np.save(DATA_DIR / "norm_mean.npy", norm_params["mean"])
    np.save(DATA_DIR / "norm_std.npy", norm_params["std"])

    np.save(DATA_DIR / "sequences.npy", X_norm)
    np.save(DATA_DIR / "labels.npy", y)
    meta.to_parquet(DATA_DIR / "dataset_meta.parquet", index=False)

    print(f"\nSaved to {DATA_DIR}/")
    print(f"  sequences.npy : {X_norm.shape}")
    print(f"  labels.npy    : {y.shape}")
    print(f"  UP rate       : {y.mean():.3f}")
    print(f"  Feature names : {FEATURE_NAMES}")


if __name__ == "__main__":
    main()
