# Yield AI on Cloudflare — train for free, serve for free

The cheapest way to run **Yield AI** (Yield's own general-purpose, all-around coder). Total
cost: **$0–$10.** It splits across two places, because **Cloudflare does not train models** —
Workers AI is inference only:

```
Train the LoRA (free)            Serve it (free)
Google Colab / Kaggle T4    →    Cloudflare Workers AI
  (a few $ at most)                (free daily allowance;
                                    LoRA free during beta)
```

> **Reality check.** This makes a **great, private, all-around ~8B assistant that's yours** —
> strong across languages, debugging, refactoring, explaining, and general questions. It does
> **not** make it Kimi/GPT/Claude level; that needs frontier-scale compute no LoRA can buy.
> The general coding ability comes from the **base model**; the LoRA adds Yield's identity and
> style. See the honest tiers in the main [README](./README.md).

---

## Step 1 — Train the LoRA for free (Colab)

Open **[`finetune/train_yield_ai_colab.ipynb`](finetune/train_yield_ai_colab.ipynb)** in Google
Colab (Runtime → T4 GPU) and run the cells. It:
- trains a rank-8 LoRA (Cloudflare's limit) on a Workers-AI-supported base — **Llama-3.1-8B**
  by default (general + coding), or Mistral/Gemma;
- mixes a public code-instruction dataset for breadth + your own examples for identity/style;
- outputs `adapter_model.safetensors` + `adapter_config.json`, zipped for download.

Free on Colab's T4. If you want a bigger base (14B) or a longer run, rent a GPU for an hour —
still under $10. (Kaggle's free 2×T4 works too.)

## Step 2 — Upload the adapter to Workers AI

Workers AI runs **your LoRA on Cloudflare's GPUs**. LoRA inference is **free during the open
beta**. Requirements: a supported **non-quantized base** (Llama / Mistral / Gemma), **rank ≤ 8**
(up to 32 in some cases), and the two adapter files.

Create a fine-tune on your account and upload the files (via the REST API — check
`npx wrangler ai finetune --help` for a CLI shortcut too):

```bash
ACCOUNT_ID=<your-account-id>
CF_API_TOKEN=<token with "Workers AI: Edit">

# 1) Create the fine-tune record (note the returned finetune id)
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/ai/finetunes" \
  -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"model":"@cf/meta/llama-3.1-8b-instruct","name":"yield-ai","description":"Yield AI general coder LoRA"}'

# 2) Upload each adapter file to that finetune (repeat for both files)
FINETUNE_ID=<id from step 1>
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/ai/finetunes/$FINETUNE_ID/finetune-assets" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -F "file_name=adapter_model.safetensors" -F "file=@adapter_model.safetensors"
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/ai/finetunes/$FINETUNE_ID/finetune-assets" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -F "file_name=adapter_config.json" -F "file=@adapter_config.json"
```

> The exact endpoint shape can change during beta — the current steps are in Cloudflare's docs:
> [Fine-tuned inference with LoRA adapters](https://developers.cloudflare.com/workers-ai/features/fine-tunes/loras/).
> The **base model in your `adapter_config.json` must match** the Workers AI base you name.

## Step 3 — Point Yield at it

Yield already has the Workers AI backend wired in — just set the vars. In **`wrangler.toml`**:

```toml
[ai]
binding = "AI"          # already added in this repo

[vars]
YIELD_AI_BACKEND  = "workers-ai"
YIELD_AI_MODEL_ID = "@cf/meta/llama-3.1-8b-instruct"   # the base your LoRA targets
YIELD_AI_LORA     = "yield-ai"                          # your fine-tune's name (blank = base only)
```

Deploy. **"Yield AI" appears in the model picker**, runs on Cloudflare's GPUs, and every build
you route to it uses *your* model — no external AI provider. Health shows on `/status`.

Want to try it with **no fine-tune first**? Leave `YIELD_AI_LORA` blank — it serves the base
model on Workers AI so you can confirm the pipeline before training.

---

## Costs & limits (be realistic)

- **Training:** free on Colab/Kaggle; a bigger base is a few $ of rented GPU. Never more than ~$10.
- **Serving:** Workers AI has a **free daily allowance** (measured in "Neurons"); LoRA is **free
  during the beta**. Light/personal use stays free; heavy use bills pay-as-you-go per request.
- **You can't run a huge model here.** Workers AI serves *their* catalog of bases + your LoRA on
  supported families — not an arbitrary 70B/671B model. For that, use the self-hosted vLLM path
  in the main [README](./README.md) (a rented multi-GPU box).

## No fine-tune, just a base model on Cloudflare?

You don't even need the LoRA to run Yield AI on Cloudflare — set `YIELD_AI_BACKEND="workers-ai"`
and a `YIELD_AI_MODEL_ID` base and you're live. The alternative (an OpenAI-compatible URL via
`YIELD_AI_BASE_URL` pointing at `https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1`) also
works, but the **`[ai]` binding path above is simpler and uses the free allowance without an API
token**.

Sources: Cloudflare Workers AI docs — [LoRA adapters](https://developers.cloudflare.com/workers-ai/features/fine-tunes/loras/),
[OpenAI compatibility](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/),
[Fine-tunes overview](https://developers.cloudflare.com/workers-ai/features/fine-tunes/).
