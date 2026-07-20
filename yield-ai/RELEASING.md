# Shipping Yield AI versions

Your model is versioned like any product. Two kinds of releases:

| Release | What changes | Effort |
|---|---|---|
| **Point release (1.0 → 1.1 → 1.2…)** | Same base model (Mistral‑7B), **more/better training data** + prompt tweaks | Small — retrain + re-upload |
| **Major release (1.x → 2.0)** | A **bigger/better base model** (Qwen2.5‑Coder, gpt‑oss‑20b, …) | Bigger — may need self‑hosting |

---

## Point release (e.g. 1.1) — the loop

1. **Add training data.** Drop more examples into `finetune/seed/*.jsonl` (or `finetune/data/`).
   A few hundred good examples of the style/answers you want is the biggest quality lever.
2. **Retrain** on Lightning AI (same as before):
   ```bash
   cd Yield && git pull
   bash yield-ai/finetune/run_lightning.sh
   ```
   → a fresh `out/yield-ai-lora/` adapter.
3. **Upload as a new fine-tune on Cloudflare** (new name per version so you can roll back):
   ```bash
   cd yield-ai/finetune/out/yield-ai-lora
   curl -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/ai/finetunes" \
     -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
     -d '{"model":"@cf/mistral/mistral-7b-instruct-v0.2-lora","name":"yield-ai-1-1","description":"Yield AI 1.1"}'
   # then upload adapter_model.safetensors + adapter_config.json to that finetune id (see cloudflare.md)
   ```
4. **Point the app at it** — in `wrangler.toml [vars]`: `YIELD_AI_LORA = "yield-ai-1-1"`.
5. **Bump the version name** (see below), then **deploy**. Done — 1.1 is live.

## Major release (2.0) — bigger base

1. Pick a stronger base (e.g. `Qwen/Qwen2.5-Coder-7B-Instruct`, or `gpt-oss-20b` via Unsloth).
2. Retrain: `python yield-ai/finetune/train_lora.py --base <that-model> --rank 8` (or the gpt‑oss notebook).
3. **Serve it:**
   - If it's a Cloudflare‑supported LoRA base (Mistral/Gemma/Llama) → upload like above.
   - Otherwise **self‑host** with vLLM (`serve.sh`) and set `YIELD_AI_BACKEND` unset + `YIELD_AI_BASE_URL` to your server. Full 32k+ context, no 5021 limits (but costs a GPU).
4. Bump the version to **2.0** and deploy.

---

## Bumping the version name

The version string lives in three spots in `src/`. Update them together (a find‑replace works):

- `src/config/models.ts` → `label: 'Yield AI 1.0'`
- `src/routes/misc.ts` → the health‑probe `label: 'Yield AI 1.0'`
- `src/lib/prompts.ts` → `YIELD_AI_IDENTITY` ("You are Yield AI 1.0 …")

```bash
# from repo root — bump every "Yield AI 1.0" to the new version:
grep -rl "Yield AI 1.0" src | xargs sed -i 's/Yield AI 1\.0/Yield AI 1.1/g'
```

Then commit + deploy. Optionally regenerate the model card (`MODEL_CARD.md`) and re‑publish the
weights to Hugging Face under the new version.

---

## Tips
- **Keep each version's adapter** (the HF repo / a per‑version Cloudflare fine‑tune) so you can roll back.
- **Test before shipping:** deploy, pick the model, send "hi" + one small build.
- **Point releases are cheap** — iterate often. Save the big base swap for when 1.x plateaus.
