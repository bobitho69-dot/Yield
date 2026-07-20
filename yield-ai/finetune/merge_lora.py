#!/usr/bin/env python3
"""
Merge a trained Yield AI LoRA adapter into its base model, producing a standalone model
folder you can serve directly with ../serve.sh (no adapter loading needed at runtime).

    python merge_lora.py --base Qwen/Qwen2.5-Coder-7B-Instruct \
                         --adapter out/yield-ai-lora \
                         --out out/yield-ai-merged

Then serve it:
    YIELD_AI_MODEL=$(pwd)/out/yield-ai-merged ../serve.sh
    # (or copy out/yield-ai-merged somewhere and point YIELD_AI_MODEL at it)

Note: merging loads the base in fp16/bf16, so this needs enough RAM/VRAM (or CPU RAM) to
hold the full model briefly. For very large bases, merge on a big-RAM box or keep serving
the adapter separately instead.
"""
import argparse
import os


def main():
    ap = argparse.ArgumentParser(description="Merge a Yield AI LoRA adapter into its base.")
    ap.add_argument("--base", required=True, help="the base model the adapter was trained on")
    ap.add_argument("--adapter", default="out/yield-ai-lora", help="path to the trained adapter")
    ap.add_argument("--out", default="out/yield-ai-merged", help="where to write the merged model")
    args = ap.parse_args()

    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from peft import PeftModel

    print(f"Loading base    : {args.base}")
    base = AutoModelForCausalLM.from_pretrained(
        args.base, torch_dtype=torch.bfloat16, device_map="cpu", trust_remote_code=True,
    )
    print(f"Applying adapter: {args.adapter}")
    merged = PeftModel.from_pretrained(base, args.adapter)
    merged = merged.merge_and_unload()

    os.makedirs(args.out, exist_ok=True)
    print(f"Saving merged   : {args.out}")
    merged.save_pretrained(args.out, safe_serialization=True)
    # Prefer the adapter's tokenizer (it may carry chat-template tweaks), else the base's.
    tok_src = args.adapter if os.path.exists(os.path.join(args.adapter, "tokenizer_config.json")) else args.base
    AutoTokenizer.from_pretrained(tok_src, trust_remote_code=True).save_pretrained(args.out)

    print(f"\n✓ Merged model at {args.out}")
    print(f"Serve it:  YIELD_AI_MODEL={os.path.abspath(args.out)} ../serve.sh")


if __name__ == "__main__":
    main()
