# Yield AI — fine-tuning (make the model truly yours)

Yield AI is a **general-purpose, all-around coder**. Fine-tuning trains a small **LoRA adapter**
so the model (a) identifies as Yield AI and (b) picks up a clean, consistent coding + general
style. The base weights stay frozen; you train a few MB of adapter — so it fits one GPU and
takes minutes-to-hours, not months.

> **The general coding ability comes from the BASE model, not the LoRA.** Fine-tuning
> specializes and brands a good open model — it does **not** turn a small model into GPT-5/Kimi.
> That's the honest trade for owning it.
>
> **Use an Apache-2.0 base so you can brand it "Yield AI" freely** (Llama/Gemma force their name
> into yours). Good picks: the Colab notebook defaults to **Mistral-7B-v0.2** (Apache; also
> Cloudflare-serveable); the CLI (`train_lora.py`) defaults to **Qwen2.5-Coder-7B** (Apache;
> stronger at code, self-host). Step up to **gpt-oss-20b** (Apache) on a 24 GB GPU for more.

## 🟢 Easiest: free on Colab → serve free on Cloudflare

Open **[`train_yield_ai_colab.ipynb`](train_yield_ai_colab.ipynb)** in Google Colab (free T4),
run the cells, download the adapter, then follow **[`../cloudflare.md`](../cloudflare.md)** to
serve it free on Cloudflare Workers AI. Total cost: **$0–$10**. The CLI path below is for local
or rented-GPU training instead.

## Steps

```bash
cd yield-ai/finetune
pip install -r requirements.txt      # on the GPU box

# 1. Build the dataset (bundled seed examples + anything you add to data/)
python prepare_data.py

# 2. Train the LoRA adapter (QLoRA, 4-bit — fits a single GPU)
python train_lora.py                                   # 7B base by default
#   or a bigger base if you have the VRAM:
python train_lora.py --base Qwen/Qwen2.5-Coder-32B-Instruct

# 3. Merge the adapter into the base -> a standalone model folder
python merge_lora.py --base Qwen/Qwen2.5-Coder-7B-Instruct --adapter out/yield-ai-lora --out out/yield-ai-merged

# 4. Serve YOUR fine-tuned model
YIELD_AI_MODEL=$(pwd)/out/yield-ai-merged ../serve.sh
```

Then wire it into Yield exactly as in the main [README](../README.md#3-wire-it-into-yield).

## Bring your own data (this is the important part)

The bundled `seed/yield_style.jsonl` is a *starter* — a handful of examples. The model gets
good when **you** add lots of real ones. Drop `.jsonl` files into `data/`, one JSON object
per line, in either shape:

```json
{"messages": [
  {"role": "system", "content": "You are Yield AI..."},
  {"role": "user", "content": "build a habit tracker"},
  {"role": "assistant", "content": "=== file: index.html ===\n..."}
]}
```

or a simple pair (auto-wrapped with a default Yield AI system prompt):

```json
{"prompt": "build a habit tracker", "response": "=== file: index.html ===\n..."}
```

**Great sources of real examples:**
- Your best Yield builds — each app's `.yield/prompts.txt` (the prompt) paired with the files
  it produced makes an ideal `{prompt, response}` example.
- Hand-written "golden" examples of the exact style/format you want reinforced.
- Identity Q&A ("what model are you?" → "I'm Yield AI…") so it never drifts.

Aim for a few hundred high-quality examples before expecting a big difference. Quality and
consistency beat volume.

## VRAM / time (rough, QLoRA 4-bit)

| Base | VRAM to train | Notes |
|------|---------------|-------|
| 7B   | ~10–12 GB | Trains on a single 16 GB card; fastest iteration |
| 14B  | ~18–22 GB | 24 GB card |
| 32B  | ~40–48 GB | A100/H100 40–80 GB |

Tune with `--epochs`, `--lr`, `--rank`, `--max-len`, `--grad-accum` (run `python train_lora.py --help`).

## Files

| File | What it does |
|------|--------------|
| `train_yield_ai_colab.ipynb` | **Free Colab notebook** — train the LoRA on a T4, download the adapter. |
| `prepare_data.py` | Validates + splits seed and your data into `data/train.jsonl` / `val.jsonl`. |
| `train_lora.py` | QLoRA supervised fine-tune → `out/yield-ai-lora/` adapter. |
| `merge_lora.py` | Merges the adapter into the base → `out/yield-ai-merged/` (servable). |
| `seed/yield_style.jsonl` | Starter examples: identity + Yield's build style/format. |
| `requirements.txt` | The training dependencies. |
