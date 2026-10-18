#!/usr/bin/env python3
"""
Train a lightweight router classifier from AGI refinery SFT JSONL.

Default label field: "s" (strategy).
"""
from __future__ import annotations

import argparse
import json
import random
from collections import Counter
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from transformers import (
    AutoModelForSequenceClassification,
    AutoTokenizer,
    DataCollatorWithPadding,
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


def resolve_label(payload: dict, field: str) -> Optional[str]:
    value = payload
    for part in field.split("."):
        if isinstance(value, dict) and part in value:
            value = value[part]
        else:
            return None
    if value is None:
        return None
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


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


def build_label_map(
    labels: List[str],
    min_count: int,
    max_labels: Optional[int],
) -> Tuple[Dict[str, int], Dict[str, int]]:
    counts = Counter(labels)
    filtered = [(label, count) for label, count in counts.items() if count >= min_count]
    if max_labels is not None and max_labels > 0:
        filtered.sort(key=lambda item: item[1], reverse=True)
        filtered = filtered[:max_labels]
    label_map = {label: idx for idx, (label, _) in enumerate(sorted(filtered))}
    kept_counts = {label: counts[label] for label in label_map}
    return label_map, kept_counts


class SimpleDataset:
    def __init__(self, encodings: Dict[str, List[List[int]]], labels: List[int]):
        self.encodings = encodings
        self.labels = labels

    def __len__(self) -> int:
        return len(self.labels)

    def __getitem__(self, idx: int) -> Dict[str, List[int]]:
        item = {key: val[idx] for key, val in self.encodings.items()}
        item["labels"] = self.labels[idx]
        return item


def prepare_dataset(
    tokenizer: AutoTokenizer,
    texts: List[str],
    labels: List[int],
    max_length: int,
):
    if HAVE_DATASETS:
        dataset = hfds.Dataset.from_dict({"text": texts, "label": labels})

        def _encode(batch):
            tokens = tokenizer(batch["text"], truncation=True, max_length=max_length)
            tokens["labels"] = batch["label"]
            return tokens

        return dataset.map(_encode, batched=True, remove_columns=["text", "label"])

    encodings = tokenizer(texts, truncation=True, max_length=max_length)
    return SimpleDataset(encodings, labels)


def resolve_lora_targets(model_type: str) -> List[str]:
    mapping = {
        "distilbert": ["q_lin", "k_lin", "v_lin", "out_lin"],
        "bert": ["query", "key", "value", "dense"],
        "roberta": ["query", "key", "value", "dense"],
        "gpt2": ["c_attn", "c_proj"],
        "llama": ["q_proj", "k_proj", "v_proj", "o_proj"],
        "mistral": ["q_proj", "k_proj", "v_proj", "o_proj"],
        "mixtral": ["q_proj", "k_proj", "v_proj", "o_proj"],
        "qwen2": ["q_proj", "k_proj", "v_proj", "o_proj"],
    }
    return mapping.get(model_type, ["q_proj", "v_proj"])


def main() -> int:
    parser = argparse.ArgumentParser(description="Train router classifier from refinery SFT JSONL.")
    parser.add_argument("--base-model", required=True, help="Backbone model name or path.")
    parser.add_argument("--train", required=True, help="SFT JSONL from agi-refinery export.")
    parser.add_argument("--eval", help="Optional eval JSONL.")
    parser.add_argument("--label-field", default="s", help="Field to predict (default: s).")
    parser.add_argument("--min-count", type=int, default=1, help="Min label frequency to keep.")
    parser.add_argument("--max-labels", type=int, default=0, help="Max labels to keep (0 = all).")
    parser.add_argument("--max-samples", type=int, default=0, help="Max samples to train on (0 = all).")
    parser.add_argument("--seed", type=int, default=7, help="Random seed for sampling.")
    parser.add_argument("--outdir", required=True, help="Directory to save the trained router.")
    parser.add_argument("--epochs", type=int, default=2, help="Number of training epochs.")
    parser.add_argument("--bsz", type=int, default=8, help="Per-device batch size.")
    parser.add_argument("--lr", type=float, default=2e-5, help="Learning rate.")
    parser.add_argument("--max-length", type=int, default=512, help="Token length cap.")
    parser.add_argument("--use-lora", action="store_true", help="Enable LoRA adapters (requires peft).")
    parser.add_argument("--lora-r", type=int, default=16, help="LoRA rank when --use-lora is set.")
    parser.add_argument("--dry-run", action="store_true", help="Validate data and exit.")
    args = parser.parse_args()

    if args.use_lora and not HAVE_PEFT:
        raise RuntimeError("peft is required for --use-lora but is not installed.")

    rows = read_jsonl(Path(args.train))
    rows = sample_rows(rows, args.max_samples if args.max_samples > 0 else None, args.seed)
    texts: List[str] = []
    labels_raw: List[str] = []
    for row in rows:
        label = resolve_label(row, args.label_field)
        text = row.get("x")
        if not label or not text:
            continue
        texts.append(str(text))
        labels_raw.append(label)

    if not texts:
        raise RuntimeError("No usable rows found for training.")

    max_labels = args.max_labels if args.max_labels > 0 else None
    label_map, label_counts = build_label_map(labels_raw, args.min_count, max_labels)
    filtered_texts: List[str] = []
    filtered_labels: List[int] = []
    for text, label in zip(texts, labels_raw):
        if label not in label_map:
            continue
        filtered_texts.append(text)
        filtered_labels.append(label_map[label])

    if not filtered_texts:
        raise RuntimeError("No rows left after label filtering.")

    output_dir = Path(args.outdir)
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "label-map.json").write_text(
        json.dumps(
            {
                "label_field": args.label_field,
                "label_to_id": label_map,
                "id_to_label": {idx: label for label, idx in label_map.items()},
                "counts": label_counts,
            },
            indent=2,
            ensure_ascii=True,
        ),
        encoding="utf-8",
    )

    if args.dry_run:
        print(f"[router] rows={len(filtered_texts)} labels={len(label_map)} outdir={output_dir}")
        return 0

    tokenizer = AutoTokenizer.from_pretrained(args.base_model, use_fast=True)
    model = AutoModelForSequenceClassification.from_pretrained(
        args.base_model,
        num_labels=len(label_map),
    )

    if args.use_lora:
        targets = resolve_lora_targets(model.config.model_type)
        config = LoraConfig(
            r=args.lora_r,
            lora_alpha=2 * args.lora_r,
            lora_dropout=0.05,
            target_modules=targets,
        )
        model = get_peft_model(model, config)

    train_ds = prepare_dataset(tokenizer, filtered_texts, filtered_labels, args.max_length)

    eval_ds = None
    if args.eval:
        eval_rows = read_jsonl(Path(args.eval))
        eval_texts: List[str] = []
        eval_labels: List[int] = []
        for row in eval_rows:
            label = resolve_label(row, args.label_field)
            text = row.get("x")
            if not label or not text or label not in label_map:
                continue
            eval_texts.append(str(text))
            eval_labels.append(label_map[label])
        if eval_texts:
            eval_ds = prepare_dataset(tokenizer, eval_texts, eval_labels, args.max_length)

    collator = DataCollatorWithPadding(tokenizer=tokenizer)
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
