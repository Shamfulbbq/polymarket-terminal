"""
train_tcn_v2.py
TCN + LSTM hybrid for btc5m prediction — matches target bot's architecture per leaked spec.

Architecture:
  Input:  (batch, SEQ_LEN=300, N_FEATURES=76)   one tick per second of a 5-min round
  TCN:    stack of dilated causal conv blocks — extracts LOCAL microstructure patterns
          (order book shifts, flow bursts, spread dynamics within ~seconds)
  LSTM:   sequential head over TCN output — captures TEMPORAL EVOLUTION
          (sentiment continuity across the round)
  Head:   final FC → logit (BCE)

Usage:
    uv run src/btc5m/train_tcn_v2.py --epochs 50
    uv run src/btc5m/train_tcn_v2.py --channels 64 --lstm_hidden 128
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, TensorDataset

ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = ROOT / "data" / "btc5m" / "v2"
MODEL_DIR = ROOT / "models"
MODEL_DIR.mkdir(exist_ok=True)


# ── TCN blocks (causal, dilated — same pattern as v1 but parameterized) ──────

class CausalConvBlock(nn.Module):
    def __init__(self, in_ch: int, out_ch: int, kernel: int, dilation: int, dropout: float):
        super().__init__()
        pad = (kernel - 1) * dilation
        self.conv1 = nn.Conv1d(in_ch, out_ch, kernel, padding=pad, dilation=dilation)
        self.conv2 = nn.Conv1d(out_ch, out_ch, kernel, padding=pad, dilation=dilation)
        self.bn1 = nn.BatchNorm1d(out_ch)
        self.bn2 = nn.BatchNorm1d(out_ch)
        self.drop = nn.Dropout(dropout)
        self.relu = nn.ReLU()
        self.downsample = nn.Conv1d(in_ch, out_ch, 1) if in_ch != out_ch else None

    def forward(self, x):
        pad = self.conv1.padding[0]
        out = self.conv1(x)
        if pad > 0:
            out = out[:, :, :-pad]
        out = self.drop(self.relu(self.bn1(out)))
        out = self.conv2(out)
        if pad > 0:
            out = out[:, :, :-pad]
        out = self.drop(self.relu(self.bn2(out)))
        res = self.downsample(x) if self.downsample is not None else x
        return self.relu(out + res)


class TCNEncoder(nn.Module):
    """Stack of dilated causal conv blocks. Output: (batch, channels, seq_len)."""

    def __init__(self, in_features: int, channels: int, kernel: int, n_layers: int, dropout: float):
        super().__init__()
        layers = []
        for i in range(n_layers):
            in_ch = in_features if i == 0 else channels
            layers.append(CausalConvBlock(in_ch, channels, kernel, 2 ** i, dropout))
        self.net = nn.Sequential(*layers)

    def forward(self, x):
        # x: (batch, seq, feat) → (batch, feat, seq)
        return self.net(x.permute(0, 2, 1))


# ── TCN → LSTM → classifier ─────────────────────────────────────────────────

class TCNLSTM(nn.Module):
    def __init__(
        self,
        num_features: int,
        tcn_channels: int = 64,
        tcn_layers: int = 6,       # 6 layers w/ dilation 1..32 covers 300-tick receptive field
        tcn_kernel: int = 3,
        lstm_hidden: int = 64,
        lstm_layers: int = 1,
        dropout: float = 0.2,
    ):
        super().__init__()
        self.tcn = TCNEncoder(num_features, tcn_channels, tcn_kernel, tcn_layers, dropout)
        self.lstm = nn.LSTM(
            input_size=tcn_channels,
            hidden_size=lstm_hidden,
            num_layers=lstm_layers,
            batch_first=True,
            dropout=dropout if lstm_layers > 1 else 0.0,
        )
        self.head = nn.Sequential(
            nn.Linear(lstm_hidden, lstm_hidden // 2),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(lstm_hidden // 2, 1),
        )

    def forward(self, x):
        # x: (batch, seq, feat)
        h = self.tcn(x)                  # (batch, tcn_ch, seq)
        h = h.permute(0, 2, 1)           # (batch, seq, tcn_ch)
        out, _ = self.lstm(h)            # (batch, seq, lstm_hidden)
        last = out[:, -1]                # final timestep
        return self.head(last).squeeze(-1)


# ── Training ────────────────────────────────────────────────────────────────

def _load():
    X = np.load(DATA_DIR / "sequences.npy")
    y = np.load(DATA_DIR / "labels.npy")
    with open(DATA_DIR / "feature_names.json") as f:
        names = json.load(f)
    return (
        torch.tensor(X, dtype=torch.float32),
        torch.tensor(y, dtype=torch.float32),
        names,
    )


def _split(X, y, frac=0.2):
    n = len(X)
    split = int(n * (1 - frac))
    return X[:split], y[:split], X[split:], y[split:]


def train(args):
    X, y, names = _load()
    num_features = X.shape[-1]
    seq_len = X.shape[1]
    print(f"Data: {X.shape}  features={num_features}  seq_len={seq_len}")
    print(f"UP rate overall: {y.mean():.3f}")

    if len(X) < 10:
        print(f"\n[WARN] Only {len(X)} rounds available - this run is for PIPELINE VALIDATION only.")
        print("       Real training requires thousands of rounds. Keep recorder running.\n")

    X_tr, y_tr, X_va, y_va = _split(X, y, args.val_frac)
    print(f"Train: {len(X_tr)}  Val: {len(X_va)}")

    tr_dl = DataLoader(TensorDataset(X_tr, y_tr), batch_size=args.batch, shuffle=True)
    va_dl = DataLoader(TensorDataset(X_va, y_va), batch_size=max(1, args.batch * 4))

    model = TCNLSTM(
        num_features=num_features,
        tcn_channels=args.channels,
        tcn_layers=args.tcn_layers,
        lstm_hidden=args.lstm_hidden,
        lstm_layers=args.lstm_layers,
        dropout=args.dropout,
    )
    n_params = sum(p.numel() for p in model.parameters())
    print(f"Model: TCN({args.channels}ch x {args.tcn_layers}L) -> LSTM({args.lstm_hidden}h x {args.lstm_layers}L) | params={n_params:,}")

    optim = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(optim, T_max=args.epochs)
    crit = nn.BCEWithLogitsLoss()

    best_acc, best_state = 0.0, None
    for ep in range(1, args.epochs + 1):
        model.train()
        tr_loss = 0.0
        for xb, yb in tr_dl:
            optim.zero_grad()
            logit = model(xb)
            loss = crit(logit, yb)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optim.step()
            tr_loss += loss.item() * len(xb)
        sched.step()

        model.eval()
        with torch.no_grad():
            if len(X_va) > 0:
                preds = []
                for xb, _ in va_dl:
                    preds.append(torch.sigmoid(model(xb)))
                preds = torch.cat(preds)
                va_acc = ((preds > 0.5).float() == y_va).float().mean().item()
                va_loss = crit(preds.clamp(1e-6, 1 - 1e-6).logit(), y_va).item()
            else:
                va_acc, va_loss = 0.0, 0.0

        if va_acc > best_acc:
            best_acc = va_acc
            best_state = {k: v.clone() for k, v in model.state_dict().items()}

        if ep % 5 == 0 or ep == 1 or ep == args.epochs:
            print(f"Epoch {ep:3d}/{args.epochs}  tr_loss={tr_loss/max(1,len(X_tr)):.4f}  "
                  f"va_loss={va_loss:.4f}  va_acc={va_acc:.4f}  best={best_acc:.4f}")

    print(f"\nBest val acc: {best_acc:.4f}")

    if best_state is not None:
        model.load_state_dict(best_state)
    torch.save({
        "state_dict": model.state_dict(),
        "val_acc": best_acc,
        "config": {
            "num_features": num_features,
            "seq_len": seq_len,
            "channels": args.channels,
            "tcn_layers": args.tcn_layers,
            "lstm_hidden": args.lstm_hidden,
            "lstm_layers": args.lstm_layers,
            "dropout": args.dropout,
        },
        "feature_names": names,
    }, MODEL_DIR / "btc5m_tcn_lstm.pt")
    print(f"Saved -> {MODEL_DIR}/btc5m_tcn_lstm.pt")

    if args.export_onnx:
        _export_onnx(model, num_features, seq_len)

    return model, best_acc


def _export_onnx(model, num_features, seq_len):
    model.eval()
    dummy = torch.zeros(1, seq_len, num_features)
    out = MODEL_DIR / "btc5m_tcn_lstm.onnx"
    torch.onnx.export(
        model, dummy, str(out),
        input_names=["features"],
        output_names=["logit"],
        dynamic_axes={"features": {0: "batch"}, "logit": {0: "batch"}},
        opset_version=17,
        dynamo=False,
    )
    print(f"Exported ONNX -> {out}")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--epochs", type=int, default=30)
    p.add_argument("--lr", type=float, default=1e-3)
    p.add_argument("--batch", type=int, default=64)
    p.add_argument("--channels", type=int, default=64)
    p.add_argument("--tcn_layers", type=int, default=6)
    p.add_argument("--lstm_hidden", type=int, default=64)
    p.add_argument("--lstm_layers", type=int, default=1)
    p.add_argument("--dropout", type=float, default=0.2)
    p.add_argument("--val_frac", type=float, default=0.2)
    p.add_argument("--export_onnx", action="store_true")
    args = p.parse_args()

    if not (DATA_DIR / "sequences.npy").exists():
        print(f"Missing {DATA_DIR / 'sequences.npy'}. Run build_dataset_v2.py first.")
        return

    train(args)


if __name__ == "__main__":
    main()
