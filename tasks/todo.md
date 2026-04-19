# TODOS

## From CEO Review (2026-04-11) — CMM Signal/Exec Split

### P2: Unit tests for feature engineering
- **What:** Test addEngineeredSignalFeatures, fracDiffClose, _std, _corrLag1, getSizedShares
- **Why:** Pure functions with known input/output — catches regressions when retraining ML models
- **Effort:** S (CC: ~10 min)
- **Depends on:** Signal/exec split completion (functions in own module)

### P2: NaN guard on ONNX feature vector
- **What:** Add `row.map(v => Number.isFinite(v) ? v : 0)` before creating tensor in scoreSignal()
- **Why:** Prevents garbage ML output if Binance returns malformed data
- **Effort:** S (CC: ~5 min, one-liner)
- **Depends on:** Nothing — can be done independently

---

## btc5m — Feature Gap vs Target Bot (2026-04-19)

Target bot's feature spec (85 cols total, via group chat leak): **TCN (local book signal) + LSTM (temporal evolution)**.

Legend: ✅ have in `ticks.jsonl` · ⚠️ derivable at training time · ❌ need raw data we don't capture

### Group 1: L2 order book (22 cols)
- ✅ `bid_px0..4`, `ask_px0..4` (10) — added 2026-04-19
- ✅ `bid_sz0..4`, `ask_sz0..4` (10) — added 2026-04-19
- ⚠️ `ofi` — derivable from L1 L2 snapshot deltas
- ⚠️ `log_total_depth` — `log(sum(bid_sz) + sum(ask_sz) + 1)`

### Group 2: Trade flow (5 cols)
- ⚠️ `trade_cnt`, `buy_vol`, `sell_vol`, `taker_imb` — have aggTrade in recorder's `FlowTracker` but NOT persisted per tick → **need to log raw flow counters into ticks.jsonl**
- ❌ `vwap_ret_bps` — requires explicit rolling VWAP tracking (not computed anywhere)

### Group 3: Derived microstructure (49 cols)
**Easy (all derivable from current tick log):**
- ⚠️ `ret_1s/5s/10s/30s/60s` from `btc_price` rolling
- ⚠️ `vol_10s/60s`, `rvol_ratio` — rolling std of returns
- ✅ `book_imb`, `wmp_bps`, `microprice_bps`, `bid_slope`, `ask_slope`, `bid_ask_sz_diff` — all from L2 snapshot
- ⚠️ `roll_spread`, `spread_ma`, `bb_pos`, `spread_diff` — derivable
- ⚠️ `vol_ratio_3_30/10_30`, `vol_term_slope`, `er_30/100` — rolling stats
- ⚠️ `acf1_sf_1s`, `run_ratio_sf_1s`, `flip_rate_sf_1s` — sign-flip statistics on returns
- ✅ `sec_in_slot_sin/cos`, `is_slot_first_10s`, `is_slot_last_30s` — trivial from `time_rem`
- ✅ `wmp_change_1s`, `depth_pressure`, `depth_imb_w` — from L2 deltas

**Medium (need per-tick flow counters first):**
- ⚠️ `queue_imb_r10/r30`, `taker_imb_r10/r30`, `aggr_buy/sell`, `trade_intensity`
- ⚠️ `ofi_r10/r30/r100/ofi_norm/ofi_l1234` — multi-scale OFI

**Hard (need new capture logic):**
- ❌ `kyle_lambda` — regression of returns on signed flow; needs per-trade tick data
- ❌ `cancel_proxy_bid/ask` — requires L2 delta tracking (detect size drops at unchanged price)
- ❌ `vol_momentum` — definition unclear without more context

### Group 4: Round state (9 cols)
- ✅ `time_remaining_s` — have `time_rem`
- ✅ `time_frac`, `time_sin`, `time_cos` — derivable
- ✅ `current_gap`, `gap_abs`, `gap_sign`, `gap_per_second`, `gap_normalized` — `round_open_price` added 2026-04-19

### Scorecard
- **Directly captured:** 22 L2 cols + `time_rem` + `btc_price` + `round_open_price` = core primitives done
- **Derivable at training time (no new capture):** ~55 cols
- **Need more recorder work:** ~8 cols (per-tick flow counters)
- **Structurally hard:** ~5 cols (Kyle's lambda, cancel proxies, vwap_ret_bps)

### ~~P0: Per-tick flow counters~~ ✅ DONE 2026-04-19
- Added 1s window to FlowTracker + buy/sell/vwap split per window
- ticks.jsonl now writes buyVol1s/3s/30s, sellVol1s/3s/30s, vwap1s/3s/30s, trades1s/3s/30s

### ~~P1: Full-depth L2 for OFI / cancel proxies~~ ✅ DONE 2026-04-19 (snapshot-diff approach)
- Computed at training time from consecutive L2 snapshots — no recorder change needed
- Added: ofi_l1, ofi_l1to5, ofi_r10/r30/r100, ofi_norm, cancel_proxy_bid/ask, kyle_lambda (rolling OLS slope)
- All 85 target features now derivable. Only sub-second / >L5 events lost (acceptable)

### ~~P1: Training pipeline v2 (`build_dataset_v2.py`)~~ ✅ DONE 2026-04-19
- Reads ticks.jsonl + rounds.jsonl, filters to rows with round_open_price (post-2026-04-19 schema)
- Computes 76 features per tick across L2, flow, derived microstructure, and round state groups
- Verified: zero NaN/Inf/constant columns. Sanity output (8, 300, 76) on current tiny dataset
- **Still missing from 85-col target spec:** Kyle's lambda, cancel proxies, full depth-diff OFI multi-scale (needs P1 full-depth stream)

### ~~P2: TCN+LSTM architecture~~ ✅ DONE 2026-04-19
- `train_tcn_v2.py`: TCN encoder (6 dilated layers, dilation 1..32, 64ch) → LSTM (64h, 1 layer) → FC head
- 192k params; receptive field covers full 300-tick round
- Smoke-tested on 8 rounds — architecture valid, gradients flow, checkpoint saves
- **Blocker:** Need thousands of rounds before training produces meaningful val_acc

### Open architectural question: prediction time
Target's state features (`current_gap`, `gap_per_second`, `is_slot_last_30s`) imply **mid-round prediction**, not at round open. Our bot places orders at round open — a major logic change. Decide: (a) stick with round-open prediction and drop state features, or (b) move to continuous mid-round inference + dynamic order adjustment. **Lean toward (b)** — matches target's apparent strategy.

---

## btc5m — v2 Bot Inference Migration (2026-04-19)

Current bot uses inline ONNX (v1 model, 13 features × 60 candles). v2 model uses 85 features × 300 ticks — a completely different input shape and feature pipeline. The v1 inference path in bot.mjs is incompatible with v2.

### P1: Migrate inference to HTTP microservice
- **What:** Update `server.py` to accept 85-feature input shape `(1, 300, 85)` (TCN+LSTM v2). Update `bot.mjs` to call the HTTP inference endpoint (like recorder does) instead of loading ONNX inline.
- **Why:** v2 model can't run inline — 85-feature tensor construction requires the full Python feature pipeline. The microservice already has all deps (numpy, onnxruntime).
- **Steps:**
  1. `server.py`: swap `SEQ_LEN=60, NUM_FEATURES=13` → `SEQ_LEN=300, NUM_FEATURES=85`
  2. `server.py`: accept raw tick buffer (last 300 ticks as JSON) and run feature engineering inline — or accept pre-computed 300×85 matrix
  3. `bot.mjs`: remove `import * as ort from 'onnxruntime-web'`, remove `loadModel()`, remove `predict()` inline tensor construction
  4. `bot.mjs`: add `predictViaHttp(tickBuffer)` that POSTs to `http://localhost:5000/predict`
  5. Confirm signal.mjs tick buffer is accessible to bot (currently separate process — may need IPC or shared file)
- **Depends on:** v2 model trained with sufficient data (thousands of rounds)

### P1: Deprecate inline ONNX after v2 migration
- **What:** After HTTP inference path verified working, remove onnxruntime-web import and v1 model path
- **Why:** Dead code + wrong model = silent wrong predictions if someone accidentally re-enables
- **Effort:** S (delete ~80 lines in bot.mjs)
- **Depends on:** HTTP inference migration complete

### P2: Shared tick buffer between recorder and bot
- **What:** recorder.mjs holds the live 300-tick buffer; bot needs it for inference. Options: (a) bot reads from shared file `data/btc5m/tick_buffer.json` that recorder writes every tick, (b) recorder spawns bot as subprocess with IPC, (c) combine into one process
- **Lean toward (a):** simplest, crash-safe, auditable
- **Effort:** M

---

## btc5m — Polymarket V2 Cutover Checklist (Before 2026-04-22)

Polymarket V2 goes live ~2026-04-22. Key changes: USDC.e → pUSD, new CTF exchange address, API changes.

### P0: Cancel all open btc5m orders before V2 cutover
- **What:** Before V2 goes live, cancel all open orders via `client.cancelAll()` or iterate open orders and cancel individually
- **Why:** V2 will likely reject or ignore orders placed under V1 contracts. Stale orders = stuck capital or phantom fills
- **How:** SSH to Ireland, `tmux attach -t btc5m_bot`, watch for cutover, or run a one-shot cancel script

### P0: Verify Gamma API post-V2
- **What:** After V2, test `fetchMarketBySlug()` still works for btc-updown-5m slugs
- **Why:** Gamma API endpoint or response schema may change at V2 boundary
- **Check:** `curl "https://gamma-api.polymarket.com/markets?slug=btc-updown-5m-<timestamp>&closed=true"` — confirm tokenIds, outcomes, prices still parse

### P1: pUSD settlement check
- **What:** After V2, confirm `resolveAndAccountPnl()` still receives correct settlement amounts
- **Why:** V1 settled in USDC.e; V2 settles in pUSD. The CTF exchange address changes. `redeemPositions()` call in claim script needs updating too.
- **Check:** Run one round in DRY_RUN, verify `finalPosition` and `pnlUsd` log correctly after round closes

### P1: Update CTF exchange address if hardcoded
- **What:** Search bot.mjs and recorder.mjs for any hardcoded CTF exchange or USDC.e contract addresses
- **Why:** V2 changes the exchange contract address; hardcoded V1 address = broken settlement
- **Check:** `grep -r "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E\|USDC.e\|0x2791" src/btc5m/`
