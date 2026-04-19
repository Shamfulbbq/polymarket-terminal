"""
server.py
FastAPI inference server — loads btc5m_tcn.onnx and serves predictions.

POST /predict
  Body: { "candles": [[ret, log_vol, taker_ratio, hl_range, body_ratio], ...] }
        Must be exactly 30 rows (SEQ_LEN), pre-normalised by the caller using
        norm_mean.npy / norm_std.npy shipped alongside the model.

  Response: {
    "pred_up": 0.62,
    "pred_dn": 0.38,
    "ev_up": null,   # caller supplies up_ask to get this
    "ev_dn": null,
  }

GET /health  — liveness check

Usage:
    uv run src/btc5m/server.py            # default port 5100
    uv run src/btc5m/server.py --port 5100

The recorder.mjs calls this server to get live predictions.
"""

import argparse
from pathlib import Path

import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

ROOT      = Path(__file__).resolve().parents[2]
MODEL_DIR = ROOT / "models"
DATA_DIR  = ROOT / "data" / "btc5m"

SEQ_LEN      = 60
NUM_FEATURES = 13

app = FastAPI(title="btc5m-tcn")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

_session = None
_norm_mean: np.ndarray | None = None
_norm_std:  np.ndarray | None = None


def _load_model():
    global _session, _norm_mean, _norm_std

    onnx_path = MODEL_DIR / "btc5m_tcn.onnx"
    if not onnx_path.exists():
        raise RuntimeError(f"ONNX model not found: {onnx_path}. Run train_tcn.py first.")

    import onnxruntime as ort
    _session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])

    mean_path = DATA_DIR / "norm_mean.npy"
    std_path  = DATA_DIR / "norm_std.npy"
    if mean_path.exists() and std_path.exists():
        _norm_mean = np.load(mean_path)
        _norm_std  = np.load(std_path)
    else:
        print("WARNING: norm_mean.npy / norm_std.npy not found — no normalisation applied")


class PredictRequest(BaseModel):
    candles: list[list[float]]  # (30, 5) — raw feature values (NOT pre-normalised)
    up_ask: float | None = None
    dn_ask: float | None = None


class PredictResponse(BaseModel):
    pred_up: float
    pred_dn: float
    ev_up: float | None
    ev_dn: float | None


@app.on_event("startup")
def startup():
    _load_model()
    print("btc5m inference server ready")


@app.get("/health")
def health():
    return {"status": "ok", "model": "btc5m_tcn.onnx"}


@app.post("/predict", response_model=PredictResponse)
def predict(req: PredictRequest):
    if len(req.candles) != SEQ_LEN:
        raise HTTPException(400, f"Expected {SEQ_LEN} candles, got {len(req.candles)}")
    if any(len(row) != NUM_FEATURES for row in req.candles):
        raise HTTPException(400, f"Each candle must have {NUM_FEATURES} features")

    x = np.array(req.candles, dtype=np.float32)  # (30, 5)

    if _norm_mean is not None:
        x = (x - _norm_mean) / _norm_std

    inp = x[np.newaxis]  # (1, 30, 5)
    logit = _session.run(None, {"candles": inp})[0][0]
    pred_up = float(1 / (1 + np.exp(-logit)))
    pred_dn = 1.0 - pred_up

    ev_up = round(pred_up - req.up_ask, 4) if req.up_ask is not None else None
    ev_dn = round(pred_dn - req.dn_ask, 4) if req.dn_ask is not None else None

    return PredictResponse(pred_up=round(pred_up, 4), pred_dn=round(pred_dn, 4),
                           ev_up=ev_up, ev_dn=ev_dn)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=5100)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
