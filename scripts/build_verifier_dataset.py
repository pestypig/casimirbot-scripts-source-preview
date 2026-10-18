#!/usr/bin/env python3
"""
Construct a verifier training corpus from the per-sample JSONL emitted by tools/run_eval.py.
"""
from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path
from typing import Dict, List


def load_candidates(path: Path) -> Dict[str, List[dict]]:
    buckets: Dict[str, List[dict]] = defaultdict(list)
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            record = json.loads(line)
            qid = str(record.get("qid"))
            buckets[qid].append(record)
    return buckets


def main() -> int:
    parser = argparse.ArgumentParser(description="Build verifier classification data from run_eval outputs.")
    parser.add_argument("--in-jsonl", required=True, help="Per-sample JSONL file from tools/run_eval.py.")
    parser.add_argument("--out-jsonl", required=True, help="Destination verifier JSONL file.")
    parser.add_argument("--max-per-q", type=int, default=0, help="Optional cap on samples per question (0 = no cap).")
    args = parser.parse_args()

    input_path = Path(args.in_jsonl)
    output_path = Path(args.out_jsonl)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    grouped = load_candidates(input_path)

    with output_path.open("w", encoding="utf-8") as writer:
        for qid, records in grouped.items():
            subset = records if args.max_per_q <= 0 else records[: args.max_per_q]
            for record in subset:
                verifier = record.get("verifier") or {}
                verdict = verifier.get("is_correct")
                label = 1 if verdict is True else 0
                text = (
                    "Problem:\n"
                    f"{record.get('prompt', '').strip()}\n\n"
                    "Candidate Solution:\n"
                    f"{record.get('response', '').strip()}\n"
                )
                writer.write(json.dumps({"qid": qid, "text": text, "label": label}, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
