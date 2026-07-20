# Fine-tuning **gpt-oss-20b** into Yield AI (free, with Unsloth)

`openai/gpt-oss-20b` is **Apache 2.0** — you can fine-tune it, sell it, and brand it **Yield AI**
freely. It's a stronger base than a 7B. The catch: gpt-oss is a special MoE / MXFP4 architecture,
so the **standard** recipe needs **~65 GB VRAM**. **[Unsloth](https://unsloth.ai)** fits it in
**~14 GB**, which means you can fine-tune it **free on Colab's T4** (or a Lightning L4).

> Because gpt-oss needs Unsloth's special handling, **don't** use `train_yield_ai_colab.ipynb`
> (that one is for Mistral/Qwen). Use Unsloth's maintained notebook below and just swap in the
> Yield dataset — their notebook is tested and kept up to date, which is what you want for a
> version-sensitive model.

## Steps

1. **Open Unsloth's free notebook:**
   [gpt-oss-(20B)-Fine-tuning.ipynb](https://colab.research.google.com/github/unslothai/notebooks/blob/main/nb/gpt-oss-(20B)-Fine-tuning.ipynb)
   (Colab → T4 GPU, or upload it to a Lightning AI Studio).

2. **Swap in the Yield dataset.** In the notebook's data cell, replace their example dataset with
   Yield's identity + general-coding examples. Use the same chat format
   (`{"messages":[{"role":"system"...},{"role":"user"...},{"role":"assistant"...}]}`) — the seed
   files in [`seed/`](seed/) (`yield_general.jsonl`, `yield_style.jsonl`) are ready to use, and add
   your own. A minimal loader you can paste:

   ```python
   import json, glob
   records = []
   for path in glob.glob('seed/*.jsonl'):        # upload the seed/ files, or paste examples inline
       for line in open(path):
           line = line.strip()
           if line:
               records.append(json.loads(line))
   from datasets import Dataset
   dataset = Dataset.from_list(records)           # each row already has a "messages" list
   ```

   Keep the identity examples ("what model are you?" → "I'm Yield AI…") so it never drifts, and
   let Unsloth apply gpt-oss's chat template (their notebook does this for you).

3. **Train** (run the cells). On a free T4 it fits in ~14 GB; give it your data and let it run.

4. **Export + serve.** gpt-oss is **not** on Cloudflare's LoRA list, so serve it yourself:
   - Save/merge the adapter (Unsloth shows how — `model.save_pretrained_merged(...)` to a full model
     or GGUF), then serve it with **[`../serve.sh`](../serve.sh)** (set `YIELD_AI_MODEL` to the merged
     folder) and point `YIELD_AI_BASE_URL` at it. Details: [`../README.md`](../README.md).

## Or don't fine-tune it at all

gpt-oss-20b (and 120b) are already pickable in Yield as **GPT-OSS 20B / 120B**, running on NVIDIA's
free endpoint — select one in the model dropdown to use it right now with no training. Fine-tune
only when you want it to *be* Yield AI (identity + your style).

Sources: [Unsloth — fine-tune gpt-oss](https://unsloth.ai/docs/models/gpt-oss-how-to-run-and-fine-tune) ·
[Unsloth blog (20b fits 14 GB)](https://unsloth.ai/blog/gpt-oss).
