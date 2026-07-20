# Yield AI 1.0 — Model Card

- **Developer:** Yield · Penusila Digital Solutions LLC
- **Model:** Yield AI 1.0
- **Type:** General-purpose coding + general-use assistant (LoRA fine-tune)
- **Base model:** [`mistralai/Mistral-7B-Instruct-v0.2`](https://huggingface.co/mistralai/Mistral-7B-Instruct-v0.2) (Apache 2.0)
- **Fine-tune:** LoRA, rank 8 (Cloudflare-compatible), QLoRA 4-bit training
- **Training data:** Yield identity examples + a general code-instruction set (see `finetune/seed/`)
- **License:** Source-available, **non-commercial** — PolyForm Noncommercial 1.0.0 (see `MODEL_LICENSE.md`)
- **Identity:** Presents itself as "Yield AI 1.0", built by Yield.

## Intended use
Building web apps and general coding assistance — through the Yield platform, or self-hosted
for non-commercial use, modification, and experimentation.

## How to run it
- **Cloudflare Workers AI:** the LoRA adapter applied to the Mistral base (see `cloudflare.md`).
- **Self-hosted:** merge the adapter (`finetune/merge_lora.py`) and serve with vLLM (`serve.sh`).

## Limitations & honest expectations
- ~7B parameters — genuinely strong for its size and specialized to Yield's style, but **not a
  frontier model**. It won't match GPT-4/Claude/Kimi on hard general reasoning.
- Always review generated code before shipping; it can be wrong or incomplete.
- Inherits the base model's biases and knowledge cutoff.

## Attribution
Built with Mistral-7B (© Mistral AI, Apache 2.0). Fine-tune and "Yield AI" identity © Yield.
