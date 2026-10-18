#!/usr/bin/env python3
"""
Build SFT and DPO corpora for rejection tuning from run_eval candidate dumps.
"""
from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path
from typing import Dict, List


def load_candidates(path: Path) -> Dict[str, List[dict]]:
    grouped: Dict[str, List[dict]] = defaultdict(list)
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            record = json.loads(line)
            grouped[str(record.get("qid"))].append(record)
    return grouped


def main() -> int:
    parser = argparse.ArgumentParser(description="Build SFT/DPO data for rejection tuning.")
    parser.add_argument("--in-jsonl", required=True, help="Per-sample JSONL file from tools/run_eval.py.")
    parser.add_argument("--out-sft", required=True, help="Destination JSONL for SFT-ready (prompt,response).")
    parser.add_argument("--out-dpo", required=True, help="Destination JSONL for DPO pairs (prompt,chosen,rejected).")
    parser.add_argument("--min-ok-per-q", type=int, default=1, help="Minimum correct samples per question to emit DPO pairs.")
    args = parser.parse_args()

    input_path = Path(args.in_jsonl)
    sft_path = Path(args.out_sft)
    dpo_path = Path(args.out_dpo)
    sft_path.parent.mkdir(parents=True, exist_ok=True)
    dpo_path.parent.mkdir(parents=True, exist_ok=True)

    grouped = load_candidates(input_path)

    with sft_path.open("w", encoding="utf-8") as sft_writer, dpo_path.open("w", encoding="utf-8") as dpo_writer:
        for records in grouped.values():
            ok = [r for r in records if (r.get("verifier") or {}).get("is_correct") is True]
            bad = [r for r in records if (r.get("verifier") or {}).get("is_correct") is not True]

            for record in ok:
                sft_writer.write(
                    json.dumps({"prompt": record.get("prompt"), "response": record.get("response")}, ensure_ascii=False)
                    + "\n"
                )

            if len(ok) < args.min_ok_per_q or not bad:
                continue

            for chosen in ok:
                for rejected in bad:
                    dpo_writer.write(
                        json.dumps(
                            {
                                "prompt": chosen.get("prompt"),
                                "chosen": chosen.get("response"),
                                "rejected": rejected.get("response"),
                            },
                            ensure_ascii=False,
                        )
                        + "\n"
                    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
