#!/usr/bin/env python3
"""
Train an answerer adapter from AGI refinery SFT JSONL (x + evidence -> y).
"""
from __future__ import annotations

import argparse
import json
import random
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    BitsAndBytesConfig,
    DataCollatorForSeq2Seq,
    Trainer,
    TrainingArguments,
)
try:
    import datasets as hfds

    HAVE_DATASETS = True
except Exception:  # noqa: BLE001
    HAVE_DATASETS = False


try:  # optional LoRA support
    from peft import LoraConfig, get_peft_model

    HAVE_PEFT = True
except Exception:  # noqa: BLE001
    HAVE_PEFT = False


def read_jsonl(path: Path) -> List[dict]:
    rows: List[dict] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def sample_rows(rows: List[dict], max_samples: Optional[int], seed: int) -> List[dict]:
    if max_samples is None or max_samples <= 0 or max_samples >= len(rows):
        return rows
    rng = random.Random(seed)
    return rng.sample(rows, max_samples)


def normalize_output(output: object) -> str:
    if output is None:
        return ""
    if isinstance(output, str):
        return output.strip()
    return json.dumps(output, ensure_ascii=True, separators=(",", ":"), sort_keys=True)


def resolve_torch_dtype(name: str):
    import torch  # noqa: PLC0415

    mapping = {
        "float16": torch.float16,
        "bfloat16": torch.bfloat16,
        "float32": torch.float32,
    }
    if name not in mapping:
        raise ValueError(f"Unsupported dtype '{name}'.")
    return mapping[name]


def ensure_bitsandbytes() -> None:
    try:
        import bitsandbytes  # noqa: PLC0415, F401
    except ImportError as exc:
        raise RuntimeError("bitsandbytes is required for --qlora") from exc


def extract_evidence_paths(evidence: List[dict], max_items: int) -> List[str]:
    paths: List[str] = []
    for item in evidence[:max_items]:
        path = item.get("path") or item.get("id") or item.get("hash")
        if not path:
            continue
        paths.append(str(path))
    return paths


def build_prompt(x: str, evidence: List[dict], evidence_max: int) -> str:
    lines = ["### Instruction", x.strip(), "", "### Evidence"]
    items = extract_evidence_paths(evidence, evidence_max)
    if items:
        lines.extend([f"- {item}" for item in items])
    else:
        lines.append("- none")
    lines.extend(["", "### Response"])
    return "\n".join(lines).strip() + "\n"


def tokenize_example(
    tokenizer: AutoTokenizer,
    prompt: str,
    output: str,
    max_length: int,
) -> Dict[str, List[int]]:
    prompt_ids = tokenizer(prompt, add_special_tokens=False).input_ids
    output_ids = tokenizer(output, add_special_tokens=False).input_ids
    eos_id = tokenizer.eos_token_id
    if eos_id is not None:
        output_ids = output_ids + [eos_id]

    if len(output_ids) >= max_length:
        output_ids = output_ids[:max_length]
        prompt_ids = []

    total_len = len(prompt_ids) + len(output_ids)
    if total_len > max_length:
        overflow = total_len - max_length
        prompt_ids = prompt_ids[overflow:]

    input_ids = prompt_ids + output_ids
    labels = [-100] * len(prompt_ids) + output_ids
    attention_mask = [1] * len(input_ids)
    return {"input_ids": input_ids, "attention_mask": attention_mask, "labels": labels}


def resolve_lora_targets(model_type: str) -> List[str]:
    mapping = {
        "gpt2": ["c_attn", "c_proj"],
        "llama": ["q_proj", "k_proj", "v_proj", "o_proj"],
        "mistral": ["q_proj", "k_proj", "v_proj", "o_proj"],
        "mixtral": ["q_proj", "k_proj", "v_proj", "o_proj"],
        "qwen2": ["q_proj", "k_proj", "v_proj", "o_proj"],
        "phi": ["q_proj", "k_proj", "v_proj", "o_proj"],
    }
    return mapping.get(model_type, ["q_proj", "v_proj"])


def main() -> int:
    parser = argparse.ArgumentParser(description="Train answerer adapter from refinery SFT JSONL.")
    parser.add_argument("--base-model", required=True, help="Base causal LM.")
    parser.add_argument("--train", required=True, help="SFT JSONL from agi-refinery export.")
    parser.add_argument("--eval", help="Optional eval JSONL.")
    parser.add_argument("--outdir", required=True, help="Directory to save the trained adapter.")
    parser.add_argument("--epochs", type=int, default=1, help="Number of training epochs.")
    parser.add_argument("--bsz", type=int, default=2, help="Per-device batch size.")
    parser.add_argument("--lr", type=float, default=2e-5, help="Learning rate.")
    parser.add_argument("--max-length", type=int, default=1024, help="Token length cap.")
    parser.add_argument("--max-samples", type=int, default=0, help="Max samples to train on (0 = all).")
    parser.add_argument("--seed", type=int, default=7, help="Random seed for sampling.")
    parser.add_argument("--evidence-max", type=int, default=12, help="Max evidence paths to include.")
    parser.add_argument("--use-lora", action="store_true", help="Enable LoRA adapters (requires peft).")
    parser.add_argument("--lora-r", type=int, default=16, help="LoRA rank when --use-lora is set.")
    parser.add_argument(
        "--qlora",
        action="store_true",
        help="Enable 4-bit QLoRA base model load (requires bitsandbytes).",
    )
    parser.add_argument(
        "--bnb-4bit-quant-type",
        default="nf4",
        choices=("nf4", "fp4"),
        help="4-bit quantization type for QLoRA.",
    )
    parser.add_argument(
        "--bnb-4bit-double-quant",
        action="store_true",
        help="Enable double-quantization for QLoRA.",
    )
    parser.add_argument(
        "--bnb-4bit-compute-dtype",
        default="bfloat16",
        choices=("float16", "bfloat16", "float32"),
        help="Compute dtype for QLoRA.",
    )
    parser.add_argument("--dry-run", action="store_true", help="Validate data and exit.")
    args = parser.parse_args()

    if args.use_lora and not HAVE_PEFT:
        raise RuntimeError("peft is required for --use-lora but is not installed.")
    if args.qlora and not args.use_lora:
        raise RuntimeError("--qlora requires --use-lora.")
    if args.qlora:
        ensure_bitsandbytes()

    rows = read_jsonl(Path(args.train))
    rows = sample_rows(rows, args.max_samples if args.max_samples > 0 else None, args.seed)

    examples: List[Dict[str, str]] = []
    for row in rows:
        x = row.get("x")
        y = row.get("y")
        if not x or not y:
            continue
        prompt = build_prompt(str(x), row.get("E") or [], args.evidence_max)
        output = normalize_output(y)
        if not output:
            continue
        examples.append({"prompt": prompt, "output": output})

    if not examples:
        raise RuntimeError("No usable rows found for training.")

    output_dir = Path(args.outdir)
    output_dir.mkdir(parents=True, exist_ok=True)

    if args.dry_run:
        print(f"[answerer] rows={len(examples)} outdir={output_dir}")
        return 0

    tokenizer = AutoTokenizer.from_pretrained(args.base_model, use_fast=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    model_kwargs: Dict[str, object] = {}
    if args.qlora:
        compute_dtype = resolve_torch_dtype(args.bnb_4bit_compute_dtype)
        model_kwargs["quantization_config"] = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type=args.bnb_4bit_quant_type,
            bnb_4bit_use_double_quant=args.bnb_4bit_double_quant,
            bnb_4bit_compute_dtype=compute_dtype,
        )
        model_kwargs["device_map"] = "auto"

    model = AutoModelForCausalLM.from_pretrained(args.base_model, **model_kwargs)
    model.config.use_cache = False

    if args.use_lora:
        targets = resolve_lora_targets(model.config.model_type)
        config = LoraConfig(
            r=args.lora_r,
            lora_alpha=2 * args.lora_r,
            lora_dropout=0.05,
            target_modules=targets,
        )
        model = get_peft_model(model, config)

    def _encode(batch):
        features = [
            tokenize_example(
                tokenizer,
                prompt=prompt,
                output=output,
                max_length=args.max_length,
            )
            for prompt, output in zip(batch["prompt"], batch["output"])
        ]
        return {
            "input_ids": [item["input_ids"] for item in features],
            "attention_mask": [item["attention_mask"] for item in features],
            "labels": [item["labels"] for item in features],
        }

    if HAVE_DATASETS:
        dataset = hfds.Dataset.from_list(examples)
        train_ds = dataset.map(_encode, batched=True, remove_columns=["prompt", "output"])
    else:
        features = _encode(
            {"prompt": [item["prompt"] for item in examples], "output": [item["output"] for item in examples]},
        )
        train_ds = [
            {
                "input_ids": features["input_ids"][idx],
                "attention_mask": features["attention_mask"][idx],
                "labels": features["labels"][idx],
            }
            for idx in range(len(features["input_ids"]))
        ]

    eval_ds = None
    if args.eval:
        eval_rows = read_jsonl(Path(args.eval))
        eval_examples: List[Dict[str, str]] = []
        for row in eval_rows:
            x = row.get("x")
            y = row.get("y")
            if not x or not y:
                continue
            prompt = build_prompt(str(x), row.get("E") or [], args.evidence_max)
            output = normalize_output(y)
            if not output:
                continue
            eval_examples.append({"prompt": prompt, "output": output})
        if eval_examples:
            if HAVE_DATASETS:
                eval_ds = hfds.Dataset.from_list(eval_examples).map(
                    _encode,
                    batched=True,
                    remove_columns=["prompt", "output"],
                )
            else:
                eval_features = _encode(
                    {"prompt": [item["prompt"] for item in eval_examples], "output": [item["output"] for item in eval_examples]},
                )
                eval_ds = [
                    {
                        "input_ids": eval_features["input_ids"][idx],
                        "attention_mask": eval_features["attention_mask"][idx],
                        "labels": eval_features["labels"][idx],
                    }
                    for idx in range(len(eval_features["input_ids"]))
                ]

    collator = DataCollatorForSeq2Seq(
        tokenizer=tokenizer,
        label_pad_token_id=-100,
    )
    training_args = TrainingArguments(
        output_dir=str(output_dir),
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.bsz,
        per_device_eval_batch_size=args.bsz,
        learning_rate=args.lr,
        weight_decay=0.01,
        eval_strategy="steps" if eval_ds is not None else "no",
        save_strategy="epoch",
        logging_steps=25,
        report_to="none",
        remove_unused_columns=False,
    )

    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=train_ds,
        eval_dataset=eval_ds,
        tokenizer=tokenizer,
        data_collator=collator,
    )
    trainer.train()

    model.save_pretrained(output_dir)
    tokenizer.save_pretrained(output_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
