"""
build_dataset_v2.py
Tick-level feature pipeline for btc5m TCN+LSTM training.

Reads:
  data/btc5m/ticks.jsonl   (per-second snapshots: L2 depth, flow counters, price, state)
  data/btc5m/rounds.jsonl  (round open/close + resolved_label)

Filters to rows with round_open_price != null (post 2026-04-19 schema).

Computes features in 4 groups (per target bot's 85-col spec):
  1. L2 order book  (22 raw + derived)
  2. Trade flow     (5)
  3. Derived microstructure (subset of 49 — what's derivable without Kyle's lambda / cancel proxies)
  4. Round state    (9)

Output:
  data/btc5m/v2/sequences.npy   (N_rounds, SEQ_LEN, N_features)
  data/btc5m/v2/labels.npy      (N_rounds,)  UP=1 DN=0
  data/btc5m/v2/meta.parquet    round_ts, slug, open_price, close_price, label, n_ticks
  data/btc5m/v2/norm_mean.npy   per-feature z-score mean (train split only)
  data/btc5m/v2/norm_std.npy    per-feature z-score std

Usage:
    uv run src/btc5m/build_dataset_v2.py
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = ROOT / "data" / "btc5m"
OUT_DIR = DATA_DIR / "v2"

SEQ_LEN = 300      # 300 ticks @ 1Hz = full 5-min round
ROUND_SEC = 300
TRAIN_FRAC = 0.8

# ─────────────────────────────────────────────────────────────────────────────
# Feature definitions
# ─────────────────────────────────────────────────────────────────────────────

L2_RAW = [
    "bid_px0", "bid_px1", "bid_px2", "bid_px3", "bid_px4",
    "ask_px0", "ask_px1", "ask_px2", "ask_px3", "ask_px4",
    "bid_sz0", "bid_sz1", "bid_sz2", "bid_sz3", "bid_sz4",
    "ask_sz0", "ask_sz1", "ask_sz2", "ask_sz3", "ask_sz4",
]

L2_DERIVED = [
    "mid_px",            # (bid_px0 + ask_px0) / 2
    "spread_abs",        # ask_px0 - bid_px0
    "spread_bps",        # spread / mid * 1e4
    "log_total_depth",   # log1p(sum(bid_sz) + sum(ask_sz))
    "book_imb",          # (B - A) / (B + A), sums
    "book_imb_l1",       # level-1 only
    "wmp_bps",           # (weighted_mid - mid) / mid * 1e4
    "microprice_bps",    # (microprice - mid) / mid * 1e4
    "bid_slope",         # regression slope of bid_sz over bid_px
    "ask_slope",
    "bid_ask_sz_diff",   # sum(bid_sz) - sum(ask_sz)
    "depth_imb_w",       # depth imbalance weighted by distance from mid
]

FLOW_RAW = [
    "trades1s", "buyVol1s", "sellVol1s", "bias1s", "vwap1s",
    "trades3s", "buyVol3s", "sellVol3s", "bias3s",
    "trades30s", "buyVol30s", "sellVol30s", "bias30s",
]

FLOW_DERIVED = [
    "taker_imb_1s",        # (buy - sell) / (buy + sell)
    "taker_imb_3s",
    "taker_imb_30s",
    "vwap_ret_bps_1s",     # (vwap1s - mid) / mid * 1e4
    "vol_ratio_3_30",      # vol3s / vol30s
    "trade_intensity",     # trades1s / mean(trades30s over round so far)
]

# Returns + volatility — derived from btc_price rolling
RET_DERIVED = [
    "ret_1s", "ret_5s", "ret_10s", "ret_30s", "ret_60s",
    "vol_10s", "vol_60s",
    "rvol_ratio",          # vol_10s / vol_60s
    "er_30",               # efficiency ratio: |ret_30| / sum(|ret_1s|, 30)
    "er_100",
]

# Sign-flip statistics on ret_1s
SIGN_FLIP = [
    "flip_rate_sf_1s",     # frac of sign-changes in last 30 ret_1s
    "run_ratio_sf_1s",     # longest run / window
]

# Order flow imbalance + cancel proxies + Kyle's lambda — all from L2 snapshot diffs
OFI = [
    "ofi_l1",              # level-1 OFI (Cont/Kukanov/Stoikov per-tick)
    "ofi_l1to5",           # summed OFI across 5 levels
    "ofi_r10",             # rolling sum of ofi_l1to5 over last 10 ticks
    "ofi_r30",             # rolling sum over 30
    "ofi_r100",            # rolling sum over 100
    "ofi_norm",            # ofi_l1to5 / total_depth
    "cancel_proxy_bid",    # sum of size drops at unchanged bid prices (per tick)
    "cancel_proxy_ask",
    "kyle_lambda",         # |Δmid| / signed_flow rolling regression slope (30s window)
]

STATE = [
    "time_remaining_s",
    "time_frac",           # (300 - time_rem) / 300
    "time_sin",
    "time_cos",
    "sec_in_slot_sin",
    "sec_in_slot_cos",
    "is_slot_first_10s",
    "is_slot_last_30s",
    "current_gap",
    "gap_abs",
    "gap_sign",
    "gap_per_second",
    "gap_normalized",
]

FEATURE_NAMES = (
    L2_RAW + L2_DERIVED + FLOW_RAW + FLOW_DERIVED + RET_DERIVED + SIGN_FLIP + OFI + STATE
)


# ─────────────────────────────────────────────────────────────────────────────
# Loaders
# ─────────────────────────────────────────────────────────────────────────────

def load_ticks(path: Path) -> pd.DataFrame:
    """Read ticks.jsonl, return DataFrame filtered to post-2026-04-19 schema."""
    rows = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            # Uniformity filter: require round_open_price + L2 data
            if d.get("round_open_price") is None:
                continue
            if d.get("bid_px0") is None or d.get("ask_px0") is None:
                continue
            rows.append(d)
    if not rows:
        raise RuntimeError(f"No ticks with full schema found in {path}")
    df = pd.DataFrame(rows)
    df = df.sort_values("ts").reset_index(drop=True)
    return df


def load_rounds(path: Path) -> pd.DataFrame:
    """Read rounds.jsonl, return DataFrame with one row per resolved round."""
    rows = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            rows.append(d)
    if not rows:
        raise RuntimeError(f"No rounds in {path}")
    df = pd.DataFrame(rows)
    # Keep only the "resolved: true" rows (ground-truth labels)
    resolved = df[df.get("resolved") == True].copy() if "resolved" in df.columns else pd.DataFrame()
    if len(resolved) == 0:
        # Fall back to provisional labels (better than nothing for early testing)
        resolved = df[df["provisional_label"].notna()].copy()
        resolved["resolved_label"] = resolved["provisional_label"]
    return resolved[["slug", "resolved_label"]].drop_duplicates(subset=["slug"], keep="last")


# ─────────────────────────────────────────────────────────────────────────────
# Feature engineering
# ─────────────────────────────────────────────────────────────────────────────

def compute_l2_derived(df: pd.DataFrame) -> pd.DataFrame:
    """Compute L2 derived features from raw bid/ask px + sz columns."""
    bid_pxs = df[[f"bid_px{i}" for i in range(5)]].values
    ask_pxs = df[[f"ask_px{i}" for i in range(5)]].values
    bid_szs = df[[f"bid_sz{i}" for i in range(5)]].values
    ask_szs = df[[f"ask_sz{i}" for i in range(5)]].values

    mid = (bid_pxs[:, 0] + ask_pxs[:, 0]) / 2.0
    spread_abs = ask_pxs[:, 0] - bid_pxs[:, 0]
    spread_bps = spread_abs / (mid + 1e-8) * 1e4

    bid_total = bid_szs.sum(axis=1)
    ask_total = ask_szs.sum(axis=1)
    total = bid_total + ask_total
    log_total_depth = np.log1p(total)
    book_imb = (bid_total - ask_total) / (total + 1e-8)
    book_imb_l1 = (bid_szs[:, 0] - ask_szs[:, 0]) / (bid_szs[:, 0] + ask_szs[:, 0] + 1e-8)

    # Weighted mid: sum(px * sz) / sum(sz) across all 10 levels
    all_pxs = np.concatenate([bid_pxs, ask_pxs], axis=1)
    all_szs = np.concatenate([bid_szs, ask_szs], axis=1)
    wmp = (all_pxs * all_szs).sum(axis=1) / (all_szs.sum(axis=1) + 1e-8)
    wmp_bps = (wmp - mid) / (mid + 1e-8) * 1e4

    # Microprice: level-1 size-weighted
    microprice = (bid_pxs[:, 0] * ask_szs[:, 0] + ask_pxs[:, 0] * bid_szs[:, 0]) / (
        bid_szs[:, 0] + ask_szs[:, 0] + 1e-8
    )
    microprice_bps = (microprice - mid) / (mid + 1e-8) * 1e4

    # Slopes — regression of size over price for each side (per-row)
    def row_slope(pxs, szs):
        x = pxs - pxs.mean(axis=1, keepdims=True)
        y = szs - szs.mean(axis=1, keepdims=True)
        num = (x * y).sum(axis=1)
        den = (x * x).sum(axis=1) + 1e-8
        return num / den

    bid_slope = row_slope(bid_pxs, bid_szs)
    ask_slope = row_slope(ask_pxs, ask_szs)
    bid_ask_sz_diff = bid_total - ask_total

    # Weighted depth imbalance — weight inversely by distance from mid
    bid_dist = np.maximum(mid[:, None] - bid_pxs, 1e-8)
    ask_dist = np.maximum(ask_pxs - mid[:, None], 1e-8)
    bid_w = (bid_szs / bid_dist).sum(axis=1)
    ask_w = (ask_szs / ask_dist).sum(axis=1)
    depth_imb_w = (bid_w - ask_w) / (bid_w + ask_w + 1e-8)

    return pd.DataFrame({
        "mid_px": mid,
        "spread_abs": spread_abs,
        "spread_bps": spread_bps,
        "log_total_depth": log_total_depth,
        "book_imb": book_imb,
        "book_imb_l1": book_imb_l1,
        "wmp_bps": wmp_bps,
        "microprice_bps": microprice_bps,
        "bid_slope": bid_slope,
        "ask_slope": ask_slope,
        "bid_ask_sz_diff": bid_ask_sz_diff,
        "depth_imb_w": depth_imb_w,
    })


def compute_flow_derived(df: pd.DataFrame) -> pd.DataFrame:
    def _imb(buy, sell):
        return (buy - sell) / (buy + sell + 1e-8)

    buy1 = df["buyVol1s"].fillna(0).values
    sell1 = df["sellVol1s"].fillna(0).values
    buy3 = df["buyVol3s"].fillna(0).values
    sell3 = df["sellVol3s"].fillna(0).values
    buy30 = df["buyVol30s"].fillna(0).values
    sell30 = df["sellVol30s"].fillna(0).values

    taker_1 = _imb(buy1, sell1)
    taker_3 = _imb(buy3, sell3)
    taker_30 = _imb(buy30, sell30)

    mid = (df["bid_px0"].values + df["ask_px0"].values) / 2.0
    vwap1 = df["vwap1s"].values.astype(float)
    # Fill NaN vwap with mid (no-trade ticks)
    nan_mask = ~np.isfinite(vwap1)
    vwap1[nan_mask] = mid[nan_mask]
    vwap_ret_bps = (vwap1 - mid) / (mid + 1e-8) * 1e4

    vol3 = df["vol3s"].fillna(0).values
    vol30 = df["vol30s"].fillna(0).values
    vol_ratio_3_30 = vol3 / (vol30 + 1e-8)

    # trade_intensity = trades1s / rolling mean within round (done per-round later).
    # For now leave as trades1s; round-level normalization happens in build().
    trade_intensity = df["trades1s"].fillna(0).values

    return pd.DataFrame({
        "taker_imb_1s": taker_1,
        "taker_imb_3s": taker_3,
        "taker_imb_30s": taker_30,
        "vwap_ret_bps_1s": vwap_ret_bps,
        "vol_ratio_3_30": vol_ratio_3_30,
        "trade_intensity": trade_intensity,
    })


def compute_returns(btc_px: np.ndarray) -> pd.DataFrame:
    """Multi-scale log returns + rolling volatility from per-second BTC price."""
    log_px = np.log(btc_px + 1e-8)

    def lagged_ret(n):
        r = np.zeros_like(log_px)
        r[n:] = log_px[n:] - log_px[:-n]
        return r

    ret_1 = lagged_ret(1)
    ret_5 = lagged_ret(5)
    ret_10 = lagged_ret(10)
    ret_30 = lagged_ret(30)
    ret_60 = lagged_ret(60)

    def rolling_std(arr, n):
        # cumulative approach — O(N) per call
        s = pd.Series(arr).rolling(n, min_periods=1).std().fillna(0).values
        return s

    vol_10 = rolling_std(ret_1, 10)
    vol_60 = rolling_std(ret_1, 60)
    rvol_ratio = vol_10 / (vol_60 + 1e-8)

    def efficiency_ratio(log_px, n):
        net = np.zeros_like(log_px)
        net[n:] = np.abs(log_px[n:] - log_px[:-n])
        gross = pd.Series(np.abs(np.diff(log_px, prepend=log_px[0]))).rolling(n, min_periods=1).sum().values
        return net / (gross + 1e-8)

    er_30 = efficiency_ratio(log_px, 30)
    er_100 = efficiency_ratio(log_px, 100)

    return pd.DataFrame({
        "ret_1s": ret_1,
        "ret_5s": ret_5,
        "ret_10s": ret_10,
        "ret_30s": ret_30,
        "ret_60s": ret_60,
        "vol_10s": vol_10,
        "vol_60s": vol_60,
        "rvol_ratio": rvol_ratio,
        "er_30": er_30,
        "er_100": er_100,
    })


def compute_sign_flip(ret_1s: np.ndarray, window: int = 30) -> pd.DataFrame:
    signs = np.sign(ret_1s)

    s = pd.Series(signs)
    # flip_rate — fraction of sign-changes in window
    diff = s.diff().fillna(0).abs().clip(upper=1)  # clip turns {0, 2} into {0, 1}
    flip_rate = diff.rolling(window, min_periods=1).mean().values

    # run_ratio — longest consecutive run of same sign in window / window
    def longest_run(arr):
        if len(arr) == 0:
            return 0
        best = cur = 1
        for i in range(1, len(arr)):
            if arr[i] == arr[i - 1] and arr[i] != 0:
                cur += 1
                best = max(best, cur)
            else:
                cur = 1
        return best

    run = np.zeros(len(signs))
    for i in range(len(signs)):
        lo = max(0, i - window + 1)
        run[i] = longest_run(signs[lo:i + 1]) / max(1, i - lo + 1)

    return pd.DataFrame({
        "flip_rate_sf_1s": flip_rate,
        "run_ratio_sf_1s": run,
    })


def compute_ofi_cancel_kyle(df: pd.DataFrame) -> pd.DataFrame:
    """Multi-scale OFI, cancel proxies, and Kyle's lambda from L2 snapshot diffs."""
    n = len(df)
    bid_pxs = df[[f"bid_px{i}" for i in range(5)]].values.astype(float)
    ask_pxs = df[[f"ask_px{i}" for i in range(5)]].values.astype(float)
    bid_szs = df[[f"bid_sz{i}" for i in range(5)]].values.astype(float)
    ask_szs = df[[f"ask_sz{i}" for i in range(5)]].values.astype(float)

    # Per-tick OFI (Cont/Kukanov/Stoikov), per level. Tick 0 has no diff → set to 0.
    # Bid contribution at level i:
    #   if bid_px_t > bid_px_{t-1}: +bid_sz_t
    #   if bid_px_t == bid_px_{t-1}: +(bid_sz_t - bid_sz_{t-1})
    #   if bid_px_t < bid_px_{t-1}: -bid_sz_{t-1}
    # Ask contribution at level i (sign flipped):
    #   if ask_px_t < ask_px_{t-1}: -ask_sz_t  (better ask = sell pressure → neg)
    #   if ask_px_t == ask_px_{t-1}: -(ask_sz_t - ask_sz_{t-1})
    #   if ask_px_t > ask_px_{t-1}: +ask_sz_{t-1}
    # OFI = bid_contrib + ask_contrib
    ofi_per_level = np.zeros((n, 5))
    if n > 1:
        bp_prev, bp_cur = bid_pxs[:-1], bid_pxs[1:]
        bs_prev, bs_cur = bid_szs[:-1], bid_szs[1:]
        ap_prev, ap_cur = ask_pxs[:-1], ask_pxs[1:]
        as_prev, as_cur = ask_szs[:-1], ask_szs[1:]

        bid_contrib = np.where(
            bp_cur > bp_prev, bs_cur,
            np.where(bp_cur == bp_prev, bs_cur - bs_prev, -bs_prev)
        )
        ask_contrib = np.where(
            ap_cur < ap_prev, -as_cur,
            np.where(ap_cur == ap_prev, -(as_cur - as_prev), as_prev)
        )
        ofi_per_level[1:] = bid_contrib + ask_contrib

    ofi_l1 = ofi_per_level[:, 0]
    ofi_l1to5 = ofi_per_level.sum(axis=1)

    def rolling_sum(arr, w):
        return pd.Series(arr).rolling(w, min_periods=1).sum().values

    ofi_r10 = rolling_sum(ofi_l1to5, 10)
    ofi_r30 = rolling_sum(ofi_l1to5, 30)
    ofi_r100 = rolling_sum(ofi_l1to5, 100)

    total_depth = bid_szs.sum(axis=1) + ask_szs.sum(axis=1)
    ofi_norm = ofi_l1to5 / (total_depth + 1e-8)

    # Cancel proxies — size drops at UNCHANGED prices (per tick, summed across levels)
    cancel_bid = np.zeros(n)
    cancel_ask = np.zeros(n)
    if n > 1:
        bid_unchanged = (bp_cur == bp_prev)
        ask_unchanged = (ap_cur == ap_prev)
        bid_size_drop = np.maximum(0.0, bs_prev - bs_cur)  # only drops
        ask_size_drop = np.maximum(0.0, as_prev - as_cur)
        cancel_bid[1:] = (bid_unchanged * bid_size_drop).sum(axis=1)
        cancel_ask[1:] = (ask_unchanged * ask_size_drop).sum(axis=1)

    # Kyle's lambda — rolling regression slope: |Δmid| ~ |signed_volume|
    # signed_volume = buyVol1s - sellVol1s
    mid = (bid_pxs[:, 0] + ask_pxs[:, 0]) / 2.0
    delta_mid = np.zeros(n)
    delta_mid[1:] = mid[1:] - mid[:-1]
    buy = df["buyVol1s"].fillna(0).values.astype(float)
    sell = df["sellVol1s"].fillna(0).values.astype(float)
    signed_vol = buy - sell

    # Per-tick lambda: rolling 30s OLS slope of |Δmid| on |signed_vol|.
    # Compute via rolling sums (avoids per-row regression cost).
    W = 30
    x = np.abs(signed_vol)
    y = np.abs(delta_mid)
    sx = pd.Series(x).rolling(W, min_periods=2).sum().values
    sy = pd.Series(y).rolling(W, min_periods=2).sum().values
    sxx = pd.Series(x * x).rolling(W, min_periods=2).sum().values
    sxy = pd.Series(x * y).rolling(W, min_periods=2).sum().values
    cnt = pd.Series(np.ones(n)).rolling(W, min_periods=2).sum().values
    num = sxy - (sx * sy) / np.maximum(cnt, 1)
    den = sxx - (sx * sx) / np.maximum(cnt, 1)
    kyle_lambda = np.where(den > 1e-8, num / den, 0.0)
    kyle_lambda = np.nan_to_num(kyle_lambda, nan=0.0, posinf=0.0, neginf=0.0)

    return pd.DataFrame({
        "ofi_l1": ofi_l1,
        "ofi_l1to5": ofi_l1to5,
        "ofi_r10": ofi_r10,
        "ofi_r30": ofi_r30,
        "ofi_r100": ofi_r100,
        "ofi_norm": ofi_norm,
        "cancel_proxy_bid": cancel_bid,
        "cancel_proxy_ask": cancel_ask,
        "kyle_lambda": kyle_lambda,
    })


def compute_state(df: pd.DataFrame) -> pd.DataFrame:
    time_rem = df["time_rem"].values.astype(float)
    time_frac = (ROUND_SEC - time_rem) / ROUND_SEC
    time_sin = np.sin(time_frac * 2 * np.pi)
    time_cos = np.cos(time_frac * 2 * np.pi)
    # sec_in_slot = elapsed seconds within round
    sec_in_slot = ROUND_SEC - time_rem
    sec_sin = np.sin(sec_in_slot / ROUND_SEC * 2 * np.pi)
    sec_cos = np.cos(sec_in_slot / ROUND_SEC * 2 * np.pi)

    is_first = (time_rem > ROUND_SEC - 10).astype(np.float32)
    is_last = (time_rem < 30).astype(np.float32)

    btc = df["btc_price"].values.astype(float)
    open_ = df["round_open_price"].values.astype(float)
    gap = btc - open_
    gap_abs = np.abs(gap)
    gap_sign = np.sign(gap)
    gap_per_sec = gap / np.maximum(sec_in_slot, 1.0)
    # normalize by open price → basis-point-like
    gap_normalized = gap / (open_ + 1e-8) * 1e4

    return pd.DataFrame({
        "time_remaining_s": time_rem,
        "time_frac": time_frac,
        "time_sin": time_sin,
        "time_cos": time_cos,
        "sec_in_slot_sin": sec_sin,
        "sec_in_slot_cos": sec_cos,
        "is_slot_first_10s": is_first,
        "is_slot_last_30s": is_last,
        "current_gap": gap,
        "gap_abs": gap_abs,
        "gap_sign": gap_sign,
        "gap_per_second": gap_per_sec,
        "gap_normalized": gap_normalized,
    })


# ─────────────────────────────────────────────────────────────────────────────
# Build
# ─────────────────────────────────────────────────────────────────────────────

def build_round_sequence(tick_df: pd.DataFrame) -> np.ndarray | None:
    """Given all ticks in one round, return (SEQ_LEN, N_features) array or None if unusable."""
    if len(tick_df) < 30:  # need at least 30 ticks (~10% of round)
        return None

    l2_der = compute_l2_derived(tick_df).reset_index(drop=True)
    flow_der = compute_flow_derived(tick_df).reset_index(drop=True)
    ret_der = compute_returns(tick_df["btc_price"].values)
    sf = compute_sign_flip(ret_der["ret_1s"].values)
    ofi = compute_ofi_cancel_kyle(tick_df).reset_index(drop=True)
    state = compute_state(tick_df).reset_index(drop=True)

    raw_l2 = tick_df[L2_RAW].reset_index(drop=True).astype(np.float64)
    raw_flow = tick_df[FLOW_RAW].reset_index(drop=True).fillna(0).astype(np.float64)

    feat_df = pd.concat(
        [raw_l2, l2_der, raw_flow, flow_der, ret_der, sf, ofi, state], axis=1
    )
    # Enforce column order
    feat_df = feat_df[FEATURE_NAMES]
    arr = feat_df.values.astype(np.float32)

    # Pad or truncate to SEQ_LEN
    if len(arr) >= SEQ_LEN:
        arr = arr[-SEQ_LEN:]
    else:
        pad = np.zeros((SEQ_LEN - len(arr), arr.shape[1]), dtype=np.float32)
        arr = np.concatenate([pad, arr], axis=0)

    # Replace any remaining NaN/inf with 0
    arr = np.nan_to_num(arr, nan=0.0, posinf=0.0, neginf=0.0)
    return arr


def build(tick_df: pd.DataFrame, rounds_df: pd.DataFrame):
    sequences, labels, meta = [], [], []

    grouped = tick_df.groupby("slug", sort=True)
    for slug, g in grouped:
        label_row = rounds_df[rounds_df["slug"] == slug]
        if len(label_row) == 0:
            continue
        resolved = label_row.iloc[0]["resolved_label"]
        if resolved not in ("UP", "DN"):
            continue
        label = 1 if resolved == "UP" else 0

        arr = build_round_sequence(g.sort_values("ts").reset_index(drop=True))
        if arr is None:
            continue

        sequences.append(arr)
        labels.append(label)
        meta.append({
            "slug": slug,
            "n_ticks": len(g),
            "open_price": float(g["round_open_price"].iloc[0]),
            "label": label,
        })

    if not sequences:
        raise RuntimeError("No usable rounds built — check filter criteria and data.")

    X = np.stack(sequences).astype(np.float32)
    y = np.array(labels, dtype=np.int64)
    meta_df = pd.DataFrame(meta)
    return X, y, meta_df


def normalize(X: np.ndarray, train_frac: float = TRAIN_FRAC):
    split = max(1, int(len(X) * train_frac))
    train_flat = X[:split].reshape(-1, X.shape[-1])
    mean = train_flat.mean(axis=0)
    std = train_flat.std(axis=0) + 1e-8
    return ((X - mean) / std).astype(np.float32), {"mean": mean, "std": std}


def main():
    ticks_path = DATA_DIR / "ticks.jsonl"
    rounds_path = DATA_DIR / "rounds.jsonl"
    if not ticks_path.exists():
        raise FileNotFoundError(f"Missing {ticks_path}. Start recorder first.")
    if not rounds_path.exists():
        raise FileNotFoundError(f"Missing {rounds_path}.")

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    print(f"Loading ticks from {ticks_path}...")
    ticks = load_ticks(ticks_path)
    print(f"  {len(ticks):,} ticks with full schema (across {ticks['slug'].nunique()} rounds)")

    print(f"Loading rounds from {rounds_path}...")
    rounds = load_rounds(rounds_path)
    print(f"  {len(rounds):,} rounds with labels")

    print("Building sequences...")
    X, y, meta = build(ticks, rounds)
    print(f"  {len(X):,} rounds built | UP={int(y.sum())} DN={int((1-y).sum())}")
    print(f"  X.shape = {X.shape}  y.shape = {y.shape}")

    print("Normalizing (train-split fit only)...")
    X_norm, norm_params = normalize(X)

    np.save(OUT_DIR / "sequences.npy", X_norm)
    np.save(OUT_DIR / "labels.npy", y)
    np.save(OUT_DIR / "norm_mean.npy", norm_params["mean"])
    np.save(OUT_DIR / "norm_std.npy", norm_params["std"])
    meta.to_parquet(OUT_DIR / "meta.parquet", index=False)

    # Feature name map — essential so training pipeline knows column order
    with open(OUT_DIR / "feature_names.json", "w") as f:
        json.dump(FEATURE_NAMES, f, indent=2)

    print(f"\nWrote to {OUT_DIR}/")
    print(f"  features: {len(FEATURE_NAMES)}")
    print(f"  sequences.npy: {X_norm.shape}")
    print(f"  labels.npy:    {y.shape}")
    print(f"  UP rate:       {y.mean():.3f}")


if __name__ == "__main__":
    main()
