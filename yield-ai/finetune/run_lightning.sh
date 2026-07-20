#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Yield AI — one-command training run (Lightning AI / any GPU box).
#
# Runs EVERY step for you and pauses only where you paste your Hugging Face key.
#
# On your Lightning Studio terminal (after attaching a GPU):
#     git clone -b claude/custom-yield-ai-019www https://github.com/bobitho69-dot/Yield.git
#     bash Yield/yield-ai/finetune/run_lightning.sh
#
# Trains a rank-8 LoRA on Mistral-7B (Apache 2.0) → yield-ai-lora.zip, ready to
# upload to Cloudflare. Total hands-on: paste your key once when it stops.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")"

BASE="${YIELD_AI_BASE_MODEL:-mistralai/Mistral-7B-Instruct-v0.2}"

echo "══════════════════════════════════════════════════════════════"
echo " Yield AI — training run"
echo "   base model : $BASE"
echo "══════════════════════════════════════════════════════════════"

echo; echo "▶ Step 1/4 — installing libraries (~2-3 min)…"
pip install -q -U -r requirements.txt

echo; echo "══════════════════════════════════════════════════════════════"
echo " ▶ Step 2/4 — Hugging Face login  ⏸  PASTE YOUR KEY WHEN PROMPTED"
echo "──────────────────────────────────────────────────────────────"
echo " • No key yet?  https://huggingface.co/settings/tokens  (type: Read)"
echo " • First click 'Agree' once here so the download works:"
echo "     https://huggingface.co/mistralai/Mistral-7B-Instruct-v0.2"
echo "══════════════════════════════════════════════════════════════"
# Prefer a token from the environment (most reliable — no interactive prompt needed):
#     export HF_TOKEN=hf_xxx    then re-run this script.
if [ -n "${HF_TOKEN:-}" ]; then
  echo "Using HF_TOKEN from the environment."
  huggingface-cli login --token "$HF_TOKEN" --add-to-git-credential >/dev/null 2>&1 || true
elif python -c "from huggingface_hub import HfApi; HfApi().whoami()" >/dev/null 2>&1; then
  echo "Already logged in to Hugging Face — continuing."
else
  echo "If no prompt appears below, press Ctrl+C and run:  export HF_TOKEN=hf_xxx  then re-run."
  huggingface-cli login
fi
# Verify we're actually authenticated before spending time downloading a gated model.
if ! python -c "from huggingface_hub import HfApi; HfApi().whoami()" >/dev/null 2>&1; then
  echo "✗ Not logged in to Hugging Face. Run:  export HF_TOKEN=hf_xxx  and re-run this script." >&2
  exit 1
fi

echo; echo "▶ Step 3/4 — building the dataset…"
python prepare_data.py

echo; echo "▶ Step 4/4 — training your Yield AI (~15-40 min, don't close the tab)…"
python train_lora.py --base "$BASE" --rank 8 --out out/yield-ai-lora

echo; echo "Packaging the adapter for Cloudflare…"
( cd out/yield-ai-lora && zip -q -r ../../yield-ai-lora.zip adapter_model.safetensors adapter_config.json )

echo; echo "══════════════════════════════════════════════════════════════"
echo " ✅ DONE.  Your Yield AI adapter:"
echo "     $(pwd)/yield-ai-lora.zip"
echo
echo " Next: upload it to Cloudflare Workers AI — see ../cloudflare.md"
echo "══════════════════════════════════════════════════════════════"
