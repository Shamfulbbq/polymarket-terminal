"""
train_tcn.py
Train a Temporal Convolutional Network to predict P(BTC UP) in 5-min Polymarket rounds.

Architecture:
  Input: (batch, SEQ_LEN=30, num_features=5) — last 30 one-minute candles
  TCN: 4 dilated causal conv blocks (dilation 1,2,4,8), residual connections
  Output: scalar sigmoid → P(UP)

Usage:
    uv run src/btc5m/train_tcn.py
    uv run src/btc5m/train_tcn.py --epochs 50 --lr 3e-4 --dropout 0.2

Outputs:
    models/btc5m_tcn.pt      — best checkpoint (torch state dict)
    models/btc5m_tcn.onnx    — ONNX export for inference server
"""

import argparse
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, TensorDataset

ROOT = Path(__file__).resolve().parents[2]
DATA_DIR  = ROOT / "data"  / "btc5m"
MODEL_DIR = ROOT / "models"
MODEL_DIR.mkdir(exist_ok=True)

SEQ_LEN      = 60
NUM_FEATURES = 13


# ── TCN building blocks ──────────────────────────────────────────────────────

class _CausalConvBlock(nn.Module):
    def __init__(self, in_ch: int, out_ch: int, kernel: int, dilation: int, dropout: float):
        super().__init__()
        pad = (kernel - 1) * dilation  # causal padding (left only)
        self.conv1 = nn.Conv1d(in_ch, out_ch, kernel, padding=pad, dilation=dilation)
        self.conv2 = nn.Conv1d(out_ch, out_ch, kernel, padding=pad, dilation=dilation)
        self.bn1   = nn.BatchNorm1d(out_ch)
        self.bn2   = nn.BatchNorm1d(out_ch)
        self.drop  = nn.Dropout(dropout)
        self.relu  = nn.ReLU()
        self.downsample = nn.Conv1d(in_ch, out_ch, 1) if in_ch != out_ch else None

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # x: (batch, in_ch, seq)
        pad = self.conv1.padding[0]
        out = self.conv1(x)
        out = out[:, :, :-pad] if pad > 0 else out   # trim future leak
        out = self.relu(self.bn1(out))
        out = self.drop(out)

        out = self.conv2(out)
        out = out[:, :, :-pad] if pad > 0 else out
        out = self.relu(self.bn2(out))
        out = self.drop(out)

        res = self.downsample(x) if self.downsample else x
        return self.relu(out + res)


class TCN(nn.Module):
    def __init__(self, num_features: int, channels: int = 32, kernel: int = 3,
                 n_layers: int = 4, dropout: float = 0.1):
        super().__init__()
        blocks = []
        for i in range(n_layers):
            in_ch  = num_features if i == 0 else channels
            dil    = 2 ** i
            blocks.append(_CausalConvBlock(in_ch, channels, kernel, dil, dropout))
        self.net  = nn.Sequential(*blocks)
        self.head = nn.Linear(channels, 1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # x: (batch, seq, features) → conv expects (batch, features, seq)
        out = self.net(x.permute(0, 2, 1))          # (batch, channels, seq)
        out = out[:, :, -1]                          # last timestep
        return self.head(out).squeeze(-1)            # (batch,)


# ── Training ─────────────────────────────────────────────────────────────────

def _load_data() -> tuple[torch.Tensor, torch.Tensor]:
    X = np.load(DATA_DIR / "sequences.npy")
    y = np.load(DATA_DIR / "labels.npy")
    return torch.tensor(X, dtype=torch.float32), torch.tensor(y, dtype=torch.float32)


def _chrono_split(X, y, test_frac=0.2):
    n = len(X)
    split = int(n * (1 - test_frac))
    return X[:split], y[:split], X[split:], y[split:]


def train(epochs: int = 30, lr: float = 1e-3, batch: int = 256,
          channels: int = 32, dropout: float = 0.1):
    X, y = _load_data()
    X_tr, y_tr, X_va, y_va = _chrono_split(X, y)
    print(f"Train: {len(X_tr):,}  Val: {len(X_va):,}  UP rate train: {y_tr.mean():.3f}")

    tr_dl = DataLoader(TensorDataset(X_tr, y_tr), batch_size=batch, shuffle=True)
    va_dl = DataLoader(TensorDataset(X_va, y_va), batch_size=batch * 4)

    model = TCN(num_features=NUM_FEATURES, channels=channels, dropout=dropout)
    optim = torch.optim.Adam(model.parameters(), lr=lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(optim, T_max=epochs)
    crit  = nn.BCEWithLogitsLoss()

    best_val, best_state = 0.0, None

    for ep in range(1, epochs + 1):
        model.train()
        tr_loss = 0.0
        for xb, yb in tr_dl:
            optim.zero_grad()
            loss = crit(model(xb), yb)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optim.step()
            tr_loss += loss.item() * len(xb)
        sched.step()

        model.eval()
        with torch.no_grad():
            va_preds = torch.cat([torch.sigmoid(model(xb)) for xb, _ in va_dl])
            va_true  = y_va
            va_acc   = ((va_preds > 0.5).float() == va_true).float().mean().item()
            va_loss  = crit(va_preds.logit().clamp(-10, 10), va_true).item()

        if va_acc > best_val:
            best_val = va_acc
            best_state = {k: v.clone() for k, v in model.state_dict().items()}

        if ep % 5 == 0 or ep == 1:
            print(f"Epoch {ep:3d}/{epochs}  tr_loss={tr_loss/len(X_tr):.4f}  "
                  f"va_loss={va_loss:.4f}  va_acc={va_acc:.4f}  best={best_val:.4f}")

    print(f"\nBest val accuracy: {best_val:.4f}")

    model.load_state_dict(best_state)
    torch.save({"state_dict": best_state, "val_acc": best_val,
                "num_features": NUM_FEATURES, "channels": channels,
                "dropout": dropout}, MODEL_DIR / "btc5m_tcn.pt")
    print(f"Saved checkpoint -> {MODEL_DIR}/btc5m_tcn.pt")

    _export_onnx(model)
    return model, best_val


def _export_onnx(model: TCN):
    model.eval()
    dummy = torch.zeros(1, SEQ_LEN, NUM_FEATURES)
    out_path = MODEL_DIR / "btc5m_tcn.onnx"
    torch.onnx.export(
        model, dummy, str(out_path),
        input_names=["candles"],
        output_names=["logit"],
        dynamic_axes={"candles": {0: "batch"}, "logit": {0: "batch"}},
        opset_version=17,
        dynamo=False,
    )
    print(f"Exported ONNX -> {out_path}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--epochs",   type=int,   default=30)
    parser.add_argument("--lr",       type=float, default=1e-3)
    parser.add_argument("--batch",    type=int,   default=256)
    parser.add_argument("--channels", type=int,   default=32)
    parser.add_argument("--dropout",  type=float, default=0.1)
    args = parser.parse_args()

    seq_path = DATA_DIR / "sequences.npy"
    if not seq_path.exists():
        print(f"Missing {seq_path}. Run build_dataset.py first.")
        return

    train(args.epochs, args.lr, args.batch, args.channels, args.dropout)


if __name__ == "__main__":
    main()
