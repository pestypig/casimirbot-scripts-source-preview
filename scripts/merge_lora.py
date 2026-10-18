#!/usr/bin/env python3
"""
Merge a LoRA adapter into a base causal LM and export merged weights.

Example:
    python scripts/merge_lora.py \
        --base-model mistralai/Mistral-7B-Instruct-v0.3 \
        --lora-path checkpoints/lora-math-sft \
        --output-dir artifacts/mistral7b-math-merged  # or $AGI_ARTIFACTS_DIR/...
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Merge a LoRA adapter into a base model.")
    parser.add_argument(
        "--base-model",
        required=True,
        help="Base model repo id or local path (e.g., mistralai/Mistral-7B-Instruct-v0.3).",
    )
    parser.add_argument(
        "--lora-path",
        required=True,
        help="Directory containing the trained LoRA adapter checkpoints.",
    )
    parser.add_argument(
        "--output-dir",
        required=True,
        help="Target directory for the merged model and tokenizer.",
    )
    parser.add_argument(
        "--dtype",
        default="bfloat16",
        choices=("float16", "bfloat16", "float32"),
        help="Torch dtype to load the base model with.",
    )
    parser.add_argument(
        "--device-map",
        default="auto",
        help="Device map string passed to from_pretrained (default: auto).",
    )
    return parser.parse_args()


def get_dtype(torch_module, name: str):
    mapping = {
        "float16": torch_module.float16,
        "bfloat16": torch_module.bfloat16,
        "float32": torch_module.float32,
    }
    if name not in mapping:
        raise ValueError(f"Unsupported dtype '{name}'.")
    return mapping[name]


def merge_lora(
    base_model: str,
    lora_path: str,
    output_dir: str,
    dtype: str,
    device_map: str,
) -> None:
    try:
        import torch  # noqa: PLC0415
        from peft import PeftModel  # noqa: PLC0415
        from transformers import AutoModelForCausalLM, AutoTokenizer  # noqa: PLC0415
    except ImportError as exc:
        missing = getattr(exc, "name", None)
        pkg = missing or "required package"
        raise RuntimeError(
            f"Missing dependency '{pkg}'. Install dependencies with "
            "`pip install torch transformers peft` and retry.",
        ) from exc

    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    dtype_obj = get_dtype(torch, dtype)
    tokenizer = AutoTokenizer.from_pretrained(base_model, use_fast=True)
    model = AutoModelForCausalLM.from_pretrained(
        base_model,
        torch_dtype=dtype_obj,
        device_map=device_map,
    )
    model = PeftModel.from_pretrained(model, lora_path)
    merged_model = model.merge_and_unload()

    merged_model.save_pretrained(output_path.as_posix())
    tokenizer.save_pretrained(output_path.as_posix())


def main() -> int:
    args = parse_args()
    try:
        merge_lora(
            base_model=args.base_model,
            lora_path=args.lora_path,
            output_dir=args.output_dir,
            dtype=args.dtype,
            device_map=args.device_map,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[merge-lora] failed: {exc}", file=sys.stderr)
        return 1
    print(f"[merge-lora] merged adapter saved to {os.path.abspath(args.output_dir)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
