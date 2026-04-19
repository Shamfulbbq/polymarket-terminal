#!/bin/bash
# deploy_ireland.sh — deploy btc5m bot + recorder to Ireland server
#
# What this does:
#   1. scp btc5m source files + trained ONNX model + norm params
#   2. Copies src/btc5m/.env.btc5m (bot-specific credentials — fill this in first)
#   3. Does NOT copy Python files (no training/server on the server)
#   4. Does NOT restart any running tmux session
#
# Run this from the repo root:  bash src/btc5m/deploy_ireland.sh
#
# After deploy, start tmux sessions manually on the server:
#   tmux new -d -s btc5m_rec 'cd ~/polymarket-terminal && node src/btc5m/recorder.mjs 2>&1 | tee -a data/btc5m/recorder.log'
#   tmux new -d -s btc5m_bot 'cd ~/polymarket-terminal && node --env-file=src/btc5m/.env.btc5m src/btc5m/bot.mjs 2>&1 | tee -a data/btc5m/bot.log'
#
# The --env-file flag loads the btc5m-specific credentials BEFORE any module code
# runs, so they override the shared .env. Requires Node v20.6+.

set -euo pipefail

KEY="C:/Users/makeo/polymarket_bot/poly.pem"
HOST="ubuntu@108.131.218.78"
REMOTE_DIR="~/polymarket-terminal"

echo "==> Ensuring remote dirs exist..."
ssh -i "$KEY" -o StrictHostKeyChecking=no "$HOST" \
  "mkdir -p ${REMOTE_DIR}/src/btc5m ${REMOTE_DIR}/models ${REMOTE_DIR}/data/btc5m"

echo "==> Copying bot.mjs + recorder.mjs + signal.mjs + .env.btc5m..."
scp -i "$KEY" -o StrictHostKeyChecking=no \
  src/btc5m/bot.mjs src/btc5m/recorder.mjs src/btc5m/signal.mjs src/btc5m/.env.btc5m \
  "$HOST:${REMOTE_DIR}/src/btc5m/"

echo "==> Copying trained model + norm params..."
scp -i "$KEY" -o StrictHostKeyChecking=no \
  models/btc5m_tcn.onnx "$HOST:${REMOTE_DIR}/models/"
scp -i "$KEY" -o StrictHostKeyChecking=no \
  data/btc5m/norm_mean.npy data/btc5m/norm_std.npy \
  "$HOST:${REMOTE_DIR}/data/btc5m/"

echo "==> Verifying remote files..."
ssh -i "$KEY" -o StrictHostKeyChecking=no "$HOST" "ls -lh ${REMOTE_DIR}/src/btc5m/ ${REMOTE_DIR}/models/btc5m_tcn.onnx ${REMOTE_DIR}/data/btc5m/norm_*.npy"

echo ""
echo "==> Deploy complete."
echo ""
echo "To start on the server:"
echo "  ssh -i \"$KEY\" $HOST"
echo "  cd ~/polymarket-terminal"
echo "  tmux new -d -s btc5m_rec 'node src/btc5m/recorder.mjs 2>&1 | tee -a data/btc5m/recorder.log'"
echo "  tmux new -d -s btc5m_bot 'node --env-file=src/btc5m/.env.btc5m src/btc5m/bot.mjs 2>&1 | tee -a data/btc5m/bot.log'"
echo ""
echo "Monitor: tmux attach -t btc5m_bot   (Ctrl-b d to detach)"
