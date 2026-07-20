#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Yield AI — start your in-house model server.
#
# Serves an open-weights model with vLLM behind an OpenAI-compatible API, so your
# Yield app can talk to it exactly like any other model — except it's YOUR server,
# on YOUR GPU, with no third-party AI provider involved.
#
# Usage:
#   cp .env.example .env      # edit the model / key / knobs
#   ./serve.sh                # reads .env and launches the server
#
# After it prints "Uvicorn running on ...", your endpoint is:
#   http://<this-host>:<port>/v1
# Put that in your Yield Worker as YIELD_AI_BASE_URL (see the repo README).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"

# Load .env if present (KEY=VALUE lines).
if [ -f "$here/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$here/.env"
  set +a
fi

# Defaults (overridable via .env or the environment).
MODEL="${YIELD_AI_MODEL:-Qwen/Qwen2.5-Coder-32B-Instruct}"
SERVED="${YIELD_AI_SERVED_NAME:-yield-ai}"
HOST="${YIELD_AI_HOST:-0.0.0.0}"
PORT="${YIELD_AI_PORT:-8000}"
MAX_LEN="${YIELD_AI_MAX_LEN:-32768}"
GPUS="${YIELD_AI_GPUS:-1}"
GPU_MEM="${YIELD_AI_GPU_MEM:-0.90}"
QUANT="${YIELD_AI_QUANT:-}"
API_KEY="${YIELD_AI_API_KEY:-}"
EXTRA="${YIELD_AI_EXTRA:-}"

# Ensure vLLM is available (the Docker image already has it).
if ! command -v vllm >/dev/null 2>&1; then
  echo "vllm not found. Install it first:  pip install 'vllm>=0.6.0'" >&2
  echo "(or use the provided Dockerfile / docker-compose.yml, which bundle it)" >&2
  exit 1
fi

args=(
  serve "$MODEL"
  --served-model-name "$SERVED"
  --host "$HOST"
  --port "$PORT"
  --max-model-len "$MAX_LEN"
  --tensor-parallel-size "$GPUS"
  --gpu-memory-utilization "$GPU_MEM"
)
[ -n "$QUANT" ]   && args+=(--quantization "$QUANT")
[ -n "$API_KEY" ] && args+=(--api-key "$API_KEY")
# shellcheck disable=SC2206
[ -n "$EXTRA" ]   && args+=($EXTRA)

echo "──────────────────────────────────────────────────────────────"
echo " Yield AI server"
echo "   model      : $MODEL"
echo "   served as  : $SERVED"
echo "   endpoint   : http://$HOST:$PORT/v1"
echo "   context    : $MAX_LEN tokens   GPUs: $GPUS   mem: $GPU_MEM"
echo "   auth       : $([ -n "$API_KEY" ] && echo 'on (Bearer key set)' || echo 'OFF — anyone who can reach the port can use it')"
echo "──────────────────────────────────────────────────────────────"
echo "When it's up, set these in your Yield Worker:"
echo "   YIELD_AI_BASE_URL = http://<public-host>:$PORT/v1"
echo "   YIELD_AI_MODEL_ID = $SERVED"
[ -n "$API_KEY" ] && echo "   YIELD_AI_API_KEY  = (the key from your .env)  # wrangler secret put YIELD_AI_API_KEY"
echo "──────────────────────────────────────────────────────────────"

exec vllm "${args[@]}"
