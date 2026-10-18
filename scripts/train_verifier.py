#!/usr/bin/env python3
"""
Train a lightweight verifier classifier on the JSONL data produced by build_verifier_dataset.py.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import List, Tuple

import datasets as hfds
from transformers import (
    AutoModelForSequenceClassification,
    AutoTokenizer,
    DataCollatorWithPadding,
    Trainer,
    TrainingArguments,
)

try:  # optional LoRA support
    from peft import LoraConfig, get_peft_model

    HAVE_PEFT = True
except Exception:  # noqa: BLE001
    HAVE_PEFT = False


def read_jsonl(path: Path) -> Tuple[List[str], List[int]]:
    texts: List[str] = []
    labels: List[int] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            payload = json.loads(line)
            texts.append(str(payload["text"]))
            labels.append(int(payload["label"]))
    return texts, labels


def prepare_dataset(tokenizer: AutoTokenizer, texts: List[str], labels: List[int], max_length: int):
    dataset = hfds.Dataset.from_dict({"text": texts, "label": labels})

    def _encode(batch):
        tokens = tokenizer(
            batch["text"],
            truncation=True,
            max_length=max_length,
        )
        tokens["labels"] = batch["label"]
        return tokens

    return dataset.map(_encode, batched=True, remove_columns=["text", "label"])


def main() -> int:
    parser = argparse.ArgumentParser(description="Train a verifier classifier.")
    parser.add_argument("--base-model", required=True, help="Backbone model name or path.")
    parser.add_argument("--train", required=True, help="Training JSONL (text,label).")
    parser.add_argument("--eval", help="Optional eval JSONL (text,label).")
    parser.add_argument("--outdir", required=True, help="Directory to save the trained verifier.")
    parser.add_argument("--epochs", type=int, default=2, help="Number of training epochs.")
    parser.add_argument("--bsz", type=int, default=8, help="Per-device batch size.")
    parser.add_argument("--lr", type=float, default=2e-5, help="Learning rate.")
    parser.add_argument("--max-length", type=int, default=1024, help="Token length cap.")
    parser.add_argument("--use-lora", action="store_true", help="Enable LoRA adapters (requires peft).")
    parser.add_argument("--lora-r", type=int, default=16, help="LoRA rank when --use-lora is set.")
    args = parser.parse_args()

    if args.use_lora and not HAVE_PEFT:
        raise RuntimeError("peft is required for --use-lora but is not installed.")

    output_dir = Path(args.outdir)
    output_dir.mkdir(parents=True, exist_ok=True)

    tokenizer = AutoTokenizer.from_pretrained(args.base_model, use_fast=True)
    model = AutoModelForSequenceClassification.from_pretrained(args.base_model, num_labels=2)

    if args.use_lora:
        config = LoraConfig(
            r=args.lora_r,
            lora_alpha=2 * args.lora_r,
            lora_dropout=0.05,
            target_modules=["q_proj", "v_proj", "k_proj", "o_proj"],
        )
        model = get_peft_model(model, config)

    train_texts, train_labels = read_jsonl(Path(args.train))
    train_ds = prepare_dataset(tokenizer, train_texts, train_labels, args.max_length)

    eval_ds = None
    if args.eval:
        eval_texts, eval_labels = read_jsonl(Path(args.eval))
        eval_ds = prepare_dataset(tokenizer, eval_texts, eval_labels, args.max_length)

    collator = DataCollatorWithPadding(tokenizer=tokenizer)
    training_args = TrainingArguments(
        output_dir=str(output_dir),
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.bsz,
        per_device_eval_batch_size=args.bsz,
        learning_rate=args.lr,
        weight_decay=0.01,
        evaluation_strategy="steps" if eval_ds is not None else "no",
        save_strategy="epoch",
        logging_steps=25,
        report_to="none",
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
