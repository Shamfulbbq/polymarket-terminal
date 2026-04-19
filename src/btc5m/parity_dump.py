"""
parity_dump.py
Dumps the first N candles of klines_1m.parquet plus the Python-computed
feature matrix to data/btc5m/parity_sample.json for parity_check.mjs.

Usage:  src/btc5m/.venv/Scripts/python.exe src/btc5m/parity_dump.py
"""

import json
from pathlib import Path

import numpy as np
import pandas as pd

import sys
sys.path.insert(0, str(Path(__file__).parent))
from build_dataset import _candle_features, TS_SCALE

ROOT     = Path(__file__).resolve().parents[2]
DATA_DIR = ROOT / "data" / "btc5m"
N        = 200

df = pd.read_parquet(DATA_DIR / "klines_1m.parquet").head(N).reset_index(drop=True)
feats = _candle_features(df)

# JS expects openTime in milliseconds. Our parquet stores microseconds (TS_SCALE=1e6).
# Convert to ms for JS: openTime_ms = openTime_us / 1000.
out = {
    "feature_names": ["ret", "log_vol", "taker_ratio", "hl_range", "body_ratio",
                      "ret_5", "ret_15", "ret_30", "vol_ratio",
                      "hour_sin", "hour_cos", "dow_sin", "dow_cos"],
    "candles": [
        {
            "openTime":       int(row.openTime // 1000),  # us -> ms for JS
            "open":           float(row.open),
            "high":           float(row.high),
            "low":            float(row.low),
            "close":          float(row.close),
            "volume":         float(row.volume),
            "takerBuyBaseVol": float(row.takerBuyBaseVol),
        }
        for row in df.itertuples(index=False)
    ],
    "features": feats.tolist(),
}

# IMPORTANT: the JS hour/dow features depend on openTime units. We pass ms to JS,
# which does `Math.floor(openTime / 1000)` -> seconds. Python _candle_features
# uses `openTime // TS_SCALE` (us -> s). Both must yield the SAME seconds value.
# Verify first candle:
py_ts_sec = int(df.openTime.iloc[0] // TS_SCALE)
js_ts_sec = int(int(df.openTime.iloc[0] // 1000) // 1000)
assert py_ts_sec == js_ts_sec, f"timestamp conversion mismatch py={py_ts_sec} js={js_ts_sec}"

out_path = DATA_DIR / "parity_sample.json"
out_path.write_text(json.dumps(out))
print(f"Wrote {len(out['candles'])} candles + features to {out_path}")
