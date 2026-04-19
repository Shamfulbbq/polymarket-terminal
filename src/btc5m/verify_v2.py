"""Sanity-check the v2 feature tensors."""
import json
from pathlib import Path
import numpy as np
import pandas as pd

OUT = Path(__file__).resolve().parents[2] / "data" / "btc5m" / "v2"

X = np.load(OUT / "sequences.npy")
y = np.load(OUT / "labels.npy")
meta = pd.read_parquet(OUT / "meta.parquet")
with open(OUT / "feature_names.json") as f:
    names = json.load(f)

print(f"X shape: {X.shape}  y: {y.shape}  meta rows: {len(meta)}")
print(f"n_features: {len(names)}")
print()

# Per-feature stats across all (round, tick) pairs
flat = X.reshape(-1, X.shape[-1])
mean = flat.mean(axis=0)
std = flat.std(axis=0)
nan_frac = np.isnan(flat).mean(axis=0)
inf_frac = np.isinf(flat).mean(axis=0)

issues = []
for i, n in enumerate(names):
    flag = ""
    if nan_frac[i] > 0:
        flag += f" NaN={nan_frac[i]:.2%}"
        issues.append(f"NaN in {n}")
    if inf_frac[i] > 0:
        flag += f" INF={inf_frac[i]:.2%}"
        issues.append(f"INF in {n}")
    if std[i] == 0:
        flag += " STD=0"
        issues.append(f"constant {n}")

print(f"{'idx':>3}  {'feature':<22}  {'mean':>12}  {'std':>12}  flags")
print("-" * 70)
for i, n in enumerate(names):
    flag = ""
    if nan_frac[i] > 0:
        flag += " NaN"
    if inf_frac[i] > 0:
        flag += " INF"
    if std[i] == 0:
        flag += " CONST"
    print(f"{i:>3}  {n:<22}  {mean[i]:>12.4f}  {std[i]:>12.4f}{flag}")

print()
print(f"Issues: {len(issues)}")
for i in issues:
    print(f"  - {i}")

print()
print("Sample tick from first round (last 5 ticks):")
for idx in [-5, -4, -3, -2, -1]:
    row = X[0, idx]
    subset = {names[i]: float(row[i]) for i in [0, 20, 32, 45, 55, 68, 69, 70]}
    print(f"  t={idx}: {subset}")
