# ◆ Yield AI — your own in-house model

**Yield AI is not a third-party API.** It's a model *you* run on a GPU *you* control, behind
an OpenAI-compatible endpoint. Your Yield app talks only to your server — no NVIDIA, no
OpenRouter, no ZenMux, no Anthropic/OpenAI in the loop. You own the weights, you can
fine-tune them, and it's branded and served as **Yield AI**.

This folder is everything you need to stand it up and wire it into the app.

---

## 🎯 Read this first — honest expectations

Being straight with you so you spend money wisely:

- **You are not pretraining a model from scratch.** A from-scratch frontier model (a true
  GPT-5 / Claude / Kimi competitor) costs **$10M–$1B+**, thousands of GPUs for months, and a
  research team. No individual can do that, and nothing in this folder pretends to.
- **What this _is_:** you take a top **open-weights** model (free and legal to run — Qwen,
  DeepSeek, Llama, Mistral…), serve it as *your* Yield AI, and optionally **fine-tune** it on
  your own data so it's genuinely specialized at building apps. It runs entirely on your
  hardware with no external AI provider.
- **Where it lands:** a well-chosen self-hosted model on a good GPU is **genuinely strong** —
  especially once fine-tuned for app-building. But be realistic: it competes in the
  *"excellent open model"* tier, not necessarily above the frontier labs across the board.
  The upside is it's **yours**: private, brandable, tunable, and cost-controlled.

If that trade — *own it and control it* over *beat the frontier labs* — is what you want,
you're in the right place.

---

## 🧭 The 4 steps

```
1. Rent a GPU  →  2. Run the server  →  3. Wire it into Yield  →  4. Verify
```

### 1) Rent a GPU

Any provider that gives you a Linux box with an NVIDIA GPU and a public port works. Popular,
cheap options: **RunPod**, **Vast.ai**, **Lambda**, **Paperspace**, **Fly.io GPUs**.

Pick the GPU from the model you want to run:

| Model (Hugging Face id)                     | Size | GPU you need                     | ~Rent/hr | Quality for app-building |
|---------------------------------------------|------|----------------------------------|----------|--------------------------|
| `Qwen/Qwen2.5-Coder-7B-Instruct`            | 7B   | 1× 16–24 GB (RTX 4090 / L4 / A10)| $0.3–0.6 | Decent — good for tinkering |
| `Qwen/Qwen2.5-Coder-14B-Instruct`           | 14B  | 1× 24–40 GB (A10G / L40S)        | $0.5–1.0 | Solid everyday builder |
| **`Qwen/Qwen2.5-Coder-32B-Instruct`** ⭐     | 32B  | 1× 48–80 GB (A100/H100) or 2× 24 GB | $1–2   | **Best value — recommended** |
| `deepseek-ai/DeepSeek-Coder-V2-Lite-Instruct` | 16B MoE | 1× 40–80 GB                   | $0.8–1.5 | Fast + strong on code |
| `Qwen/Qwen2.5-72B-Instruct`                 | 72B  | 2–4× 80 GB                       | $4–8     | Approaches strong hosted models |
| `deepseek-ai/DeepSeek-V3` / `V3.1`          | 671B MoE | 8× 80 GB                     | $15–30   | Closest to frontier; pricey |

> ⭐ Start with **Qwen2.5-Coder-32B-Instruct** — the best quality-per-dollar for building
> apps. To fit it on a single 24 GB card, use a 4-bit quant (`Qwen/Qwen2.5-Coder-32B-Instruct-AWQ`
> with `YIELD_AI_QUANT=awq`). These are real, downloadable models today; swap in any newer
> open coder as they ship — nothing else needs to change.

**Cost tip:** you only pay while the GPU is on. Turn it off when you're not building. A few
hours of use is a few dollars — far cheaper than it sounds.

### 2) Run the server

On the GPU box, clone this repo (or just copy this `yield-ai/` folder), then:

**Option A — Docker (simplest, recommended):**
```bash
cd yield-ai
cp .env.example .env          # edit YIELD_AI_MODEL, set a YIELD_AI_API_KEY
docker compose up             # pulls vLLM, downloads the model, serves it
```

**Option B — bare metal (no Docker):**
```bash
pip install "vllm>=0.6.0"
cd yield-ai
cp .env.example .env          # edit model / key / knobs
./serve.sh
```

Either way, when you see `Uvicorn running on http://0.0.0.0:8000`, your model is live at:

```
http://<your-gpu-host>:8000/v1
```

> 🔒 **Set `YIELD_AI_API_KEY`** in `.env` (any long random string — `openssl rand -hex 32`)
> if the port is reachable from the internet, otherwise anyone who finds it can use your GPU.
> For real deployments, put it behind HTTPS (a reverse proxy like Caddy, or a Cloudflare
> Tunnel) so the base URL is `https://…`.

**Local instead of cloud?** Use `Modelfile` with [Ollama](https://ollama.com) — see the
comments in that file. Same wiring, smaller model, runs on your own machine.

### 3) Wire it into Yield

In your Yield Worker config, point Yield at your server. In **`wrangler.toml` → `[vars]`**:

```toml
YIELD_AI_BASE_URL = "https://<your-gpu-host>/v1"   # or http://<ip>:8000/v1
YIELD_AI_MODEL_ID = "yield-ai"                       # = YIELD_AI_SERVED_NAME from .env
```

And if your server has a key, set it as a **secret** (not in the file):

```bash
wrangler secret put YIELD_AI_API_KEY
# for local dev, add YIELD_AI_API_KEY=... to your .dev.vars
```

That's it. The moment `YIELD_AI_BASE_URL` is set, **"Yield AI" appears at the top of the
model picker** and every build you route to it hits only your server. Leave it blank and the
model stays hidden — no dead option.

### 4) Verify

```bash
# from anywhere that can reach the server:
YIELD_AI_BASE_URL=https://<your-gpu-host>/v1 YIELD_AI_API_KEY=xxxx ./smoke_test.sh
```

You should see a model list and a one-line reply. Then open Yield, pick **Yield AI** in the
model dropdown, and build something. Ask it *"what model are you?"* — it should answer that
it's Yield AI. 🎉

---

## 🛠 How it fits the app (no magic)

- The Yield Worker already speaks the OpenAI `/v1/chat/completions` format (`src/lib/nvidia.ts`).
- `src/config/models.ts` has a first-party **`yield-ai`** model whose endpoint + served id
  resolve from your env vars at request time (`YIELD_AI_BASE_URL`, `YIELD_AI_MODEL_ID`).
- It's shown in the picker only when configured (`activeCoderModels` / `isYieldAIConfigured`).
- When you select it, the builder injects a **Yield AI identity** system prompt (`YIELD_AI_IDENTITY`
  in `src/lib/prompts.ts`) so it presents as Yield's own model.
- If your server is ever unreachable mid-build, Yield falls back to the hosted models so the
  build still completes (resilience). Keep your server up to stay fully in-house.

---

## 🧬 Make it truly *yours* — fine-tune it (optional)

Serving an open model as Yield AI is real, but it's still someone else's weights. To make it
**custom** — better at Yield-style app building and unmistakably yours — fine-tune it on your
own examples. See **[`finetune/`](./finetune/)** for a ready-to-run LoRA pipeline:

```bash
cd yield-ai/finetune
pip install -r requirements.txt
python prepare_data.py         # build a dataset (seed examples + your own)
python train_lora.py           # train a LoRA adapter on your base model
```

You get a small adapter you can merge into the model and serve the same way — now it's a
`yield-ai` checkpoint you trained. Details, data format, and GPU needs are in that folder's
README.

---

## 🩹 Troubleshooting

| Symptom | Fix |
|--------|-----|
| `CUDA out of memory` on startup | Lower `YIELD_AI_MAX_LEN` (e.g. 16384) and/or `YIELD_AI_GPU_MEM` (0.85), or use a smaller model / a quantized (`-AWQ`) checkpoint with `YIELD_AI_QUANT=awq`. |
| Yield AI not in the picker | `YIELD_AI_BASE_URL` isn't set (or is blank). Set it in `wrangler.toml [vars]` and redeploy. |
| `401` from the model | Your `YIELD_AI_API_KEY` in Yield doesn't match the `--api-key` the server started with. Make them identical (or clear both). |
| `404 model not found` | `YIELD_AI_MODEL_ID` must equal `YIELD_AI_SERVED_NAME`. Both default to `yield-ai`. |
| Works locally, not from Yield | The GPU box's port must be reachable from Cloudflare. Open the firewall/port, or use a Cloudflare Tunnel and use its HTTPS URL as `YIELD_AI_BASE_URL`. |
| Slow first request | The model is downloading/loading into VRAM. Subsequent requests are fast; the compose file caches weights so restarts are quick. |

---

## 📁 Files in this folder

| File | What it is |
|------|-----------|
| `serve.sh` | Launches the vLLM server from your `.env`. The main entry point. |
| `.env.example` | All the server knobs (model, key, context, GPUs). Copy to `.env`. |
| `Dockerfile` / `docker-compose.yml` | Containerized, one-command serving. |
| `Modelfile` | Ollama build — the lightweight, local, smaller-model alternative. |
| `yield-ai.system.txt` | The Yield AI identity/persona prompt. |
| `smoke_test.sh` | Curls a running server to confirm it's live and OpenAI-compatible. |
| `finetune/` | Optional LoRA pipeline to specialize the model into a real `yield-ai` checkpoint. |

Built for Yield · Penusila Digital Solutions LLC · MIT.
