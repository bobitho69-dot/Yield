#!/usr/bin/env python3
"""
Fine-tune Yield AI with QLoRA (4-bit base + a small trainable LoRA adapter).

This trains an adapter on your chat-format data (data/train.jsonl from prepare_data.py)
so the model builds apps the Yield way and identifies as Yield AI. The base weights stay
frozen — you only train a few MB of adapter, which is why this fits a single GPU.

Quick start (on the GPU box, after `pip install -r requirements.txt`):
    python prepare_data.py
    python train_lora.py                         # defaults to a 7B base + QLoRA
    # bigger base if you have the VRAM:
    python train_lora.py --base Qwen/Qwen2.5-Coder-32B-Instruct

Output: out/yield-ai-lora/  (the adapter). Merge it with merge_lora.py, then serve the
merged model with ../serve.sh exactly like any other model.

Rough VRAM (QLoRA, 4-bit): 7B ≈ 10–12 GB · 14B ≈ 18–22 GB · 32B ≈ 40–48 GB.
"""
import argparse
import os

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "data")
OUT_DIR = os.path.join(HERE, "out", "yield-ai-lora")


def main():
    ap = argparse.ArgumentParser(description="QLoRA fine-tune for Yield AI.")
    ap.add_argument("--base", default=os.environ.get("YIELD_AI_BASE_MODEL", "Qwen/Qwen2.5-Coder-7B-Instruct"),
                    help="base open-weights model (HF id or local path)")
    ap.add_argument("--epochs", type=float, default=3.0)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--batch", type=int, default=1, help="per-device batch size")
    ap.add_argument("--grad-accum", type=int, default=16, help="gradient accumulation steps")
    ap.add_argument("--max-len", type=int, default=4096, help="max sequence length (tokens)")
    ap.add_argument("--rank", type=int, default=16, help="LoRA rank")
    ap.add_argument("--alpha", type=int, default=32, help="LoRA alpha")
    ap.add_argument("--out", default=OUT_DIR)
    args = ap.parse_args()

    # Imports are inside main so `--help` works without the heavy deps installed.
    import torch
    from datasets import load_dataset
    from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
    from peft import LoraConfig, prepare_model_for_kbit_training
    from trl import SFTConfig, SFTTrainer

    train_path = os.path.join(DATA_DIR, "train.jsonl")
    if not os.path.exists(train_path):
        raise SystemExit("No data/train.jsonl — run `python prepare_data.py` first.")

    print(f"Base model : {args.base}")
    print(f"Train data : {train_path}")

    tok = AutoTokenizer.from_pretrained(args.base, trust_remote_code=True)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token

    # Render each example to a single training string via the model's chat template.
    def to_text(ex):
        return {"text": tok.apply_chat_template(ex["messages"], tokenize=False, add_generation_prompt=False)}

    ds = load_dataset("json", data_files={"train": train_path}, split="train").map(
        to_text, remove_columns=["messages"]
    )
    val_ds = None
    val_path = os.path.join(DATA_DIR, "val.jsonl")
    if os.path.exists(val_path):
        val_ds = load_dataset("json", data_files={"val": val_path}, split="val").map(
            to_text, remove_columns=["messages"]
        )

    # 4-bit (QLoRA) so a large base fits a single GPU.
    bnb = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_use_double_quant=True,
        bnb_4bit_compute_dtype=torch.bfloat16,
    )
    model = AutoModelForCausalLM.from_pretrained(
        args.base, quantization_config=bnb, device_map="auto",
        torch_dtype=torch.bfloat16, trust_remote_code=True,
    )
    model = prepare_model_for_kbit_training(model)
    model.config.use_cache = False

    lora = LoraConfig(
        r=args.rank, lora_alpha=args.alpha, lora_dropout=0.05, bias="none",
        task_type="CAUSAL_LM",
        # Attention + MLP projections — the standard, model-agnostic LoRA target set.
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    )

    sft = SFTConfig(
        output_dir=args.out,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch,
        gradient_accumulation_steps=args.grad_accum,
        learning_rate=args.lr,
        lr_scheduler_type="cosine",
        warmup_ratio=0.03,
        logging_steps=5,
        save_strategy="epoch",
        bf16=True,
        gradient_checkpointing=True,
        dataset_text_field="text",
        max_seq_length=args.max_len,
        packing=False,
        report_to="none",
    )

    # TRL renamed the tokenizer arg to processing_class in newer versions — support both.
    trainer_kwargs = dict(model=model, args=sft, train_dataset=ds, eval_dataset=val_ds, peft_config=lora)
    try:
        trainer = SFTTrainer(processing_class=tok, **trainer_kwargs)
    except TypeError:
        trainer = SFTTrainer(tokenizer=tok, **trainer_kwargs)

    trainer.train()
    trainer.save_model(args.out)
    tok.save_pretrained(args.out)
    print(f"\n✓ Adapter saved to {args.out}")
    print("Next:  python merge_lora.py --base %s --adapter %s" % (args.base, args.out))


if __name__ == "__main__":
    main()
