#!/usr/bin/env python3
"""
Build a Yield AI fine-tuning dataset.

Collects chat-format examples from:
  - seed/*.jsonl        (the bundled Yield-style examples + identity)
  - data/*.jsonl        (YOUR OWN examples — drop files here; see the format below)

...validates them, shuffles, splits into train/val, and writes:
  - data/train.jsonl
  - data/val.jsonl

Each input line is ONE JSON object in either of these shapes:

  {"messages": [{"role": "system", "content": "..."},
                {"role": "user", "content": "..."},
                {"role": "assistant", "content": "..."}]}

  or a simple pair (auto-wrapped with a default Yield AI system prompt):

  {"prompt": "build a ...", "response": "=== file: index.html ===\\n..."}

Run:  python prepare_data.py            # default 95/5 split
      python prepare_data.py --val 0.1  # 10% validation
"""
import argparse
import glob
import json
import os
import random

HERE = os.path.dirname(os.path.abspath(__file__))
SEED_DIR = os.path.join(HERE, "seed")
DATA_DIR = os.path.join(HERE, "data")

DEFAULT_SYSTEM = (
    "You are Yield AI, Yield's own in-house model, built by the Yield team "
    "(Penusila Digital Solutions). You build complete, polished, multi-file web apps."
)

VALID_ROLES = {"system", "user", "assistant"}


def normalize(obj):
    """Return a validated {'messages': [...]} record, or None if unusable."""
    if not isinstance(obj, dict):
        return None
    # Simple prompt/response pair -> wrap into chat messages.
    if "messages" not in obj and "prompt" in obj and "response" in obj:
        obj = {
            "messages": [
                {"role": "system", "content": DEFAULT_SYSTEM},
                {"role": "user", "content": str(obj["prompt"])},
                {"role": "assistant", "content": str(obj["response"])},
            ]
        }
    msgs = obj.get("messages")
    if not isinstance(msgs, list) or not msgs:
        return None
    clean = []
    for m in msgs:
        if not isinstance(m, dict):
            return None
        role, content = m.get("role"), m.get("content")
        if role not in VALID_ROLES or not isinstance(content, str) or not content.strip():
            return None
        clean.append({"role": role, "content": content})
    # Must contain at least one user turn and one assistant turn to be trainable.
    roles = {m["role"] for m in clean}
    if "assistant" not in roles or "user" not in roles:
        return None
    return {"messages": clean}


def load_jsonl_files(paths):
    records, skipped = [], 0
    for path in paths:
        with open(path, "r", encoding="utf-8") as f:
            for lineno, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    skipped += 1
                    print(f"  ! {os.path.basename(path)}:{lineno} — bad JSON, skipped")
                    continue
                rec = normalize(obj)
                if rec is None:
                    skipped += 1
                    print(f"  ! {os.path.basename(path)}:{lineno} — invalid record, skipped")
                    continue
                records.append(rec)
    return records, skipped


def main():
    ap = argparse.ArgumentParser(description="Build the Yield AI fine-tuning dataset.")
    ap.add_argument("--val", type=float, default=0.05, help="validation fraction (default 0.05)")
    ap.add_argument("--seed", type=int, default=42, help="shuffle seed (default 42)")
    args = ap.parse_args()

    os.makedirs(DATA_DIR, exist_ok=True)

    seed_files = sorted(glob.glob(os.path.join(SEED_DIR, "*.jsonl")))
    # Your own data — anything in data/ EXCEPT the outputs we generate.
    user_files = sorted(
        p for p in glob.glob(os.path.join(DATA_DIR, "*.jsonl"))
        if os.path.basename(p) not in ("train.jsonl", "val.jsonl")
    )

    print(f"Seed files : {len(seed_files)}  ({', '.join(os.path.basename(p) for p in seed_files) or 'none'})")
    print(f"Your files : {len(user_files)}  ({', '.join(os.path.basename(p) for p in user_files) or 'none — add your own to data/'})")

    records, skipped = load_jsonl_files(seed_files + user_files)
    if not records:
        print("\nNo usable records found. Add examples to data/ (see the format at the top of this file).")
        raise SystemExit(1)

    random.seed(args.seed)
    random.shuffle(records)

    n_val = max(1, int(len(records) * args.val)) if len(records) > 20 else 0
    val = records[:n_val]
    train = records[n_val:]

    def dump(path, rows):
        with open(path, "w", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")

    dump(os.path.join(DATA_DIR, "train.jsonl"), train)
    if val:
        dump(os.path.join(DATA_DIR, "val.jsonl"), val)

    print(f"\n✓ {len(records)} records ({skipped} skipped)")
    print(f"  train: {len(train)}  ->  data/train.jsonl")
    print(f"  val:   {len(val)}  ->  data/val.jsonl" if val else "  val:   0 (too few records to split)")
    print("\nNext:  python train_lora.py")


if __name__ == "__main__":
    main()
