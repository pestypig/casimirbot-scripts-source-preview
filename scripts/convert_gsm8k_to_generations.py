#!/usr/bin/env python3
"""
Utility to convert GSM8K-style JSONL into the prompt/gold format expected by tools/run_eval.py.
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

FINAL_PATTERN = re.compile(r"####\s*(.+)$", re.DOTALL | re.MULTILINE)


def extract_gold(answer: str) -> str:
    match = FINAL_PATTERN.search(answer.strip())
    if match:
        return match.group(1).strip()
    return answer.strip()


def convert(in_path: Path, out_path: Path, dataset: str, split: str) -> None:
    with in_path.open("r", encoding="utf-8") as reader, out_path.open("w", encoding="utf-8") as writer:
        for idx, line in enumerate(reader):
            line = line.strip()
            if not line:
                continue
            payload = json.loads(line)
            question = payload.get("question") or payload.get("prompt") or ""
            answer = payload.get("answer") or payload.get("solution") or ""
            record = {
                "id": payload.get("id", f"{dataset}:{split}:{idx}"),
                "prompt": question,
                "gold": extract_gold(answer),
                "meta": {"dataset": dataset, "split": split},
            }
            writer.write(json.dumps(record, ensure_ascii=False) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser(description="Convert GSM8K JSONL into generation records.")
    parser.add_argument("--in", dest="input_path", required=True, help="Source GSM8K JSONL file.")
    parser.add_argument("--out", dest="output_path", required=True, help="Destination JSONL file.")
    parser.add_argument("--split", default="train", help="Dataset split label (default: train).")
    parser.add_argument("--dataset-name", default="gsm8k", help="Dataset name stored in metadata.")
    args = parser.parse_args()

    in_path = Path(args.input_path)
    out_path = Path(args.output_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    convert(in_path, out_path, dataset=args.dataset_name, split=args.split)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
