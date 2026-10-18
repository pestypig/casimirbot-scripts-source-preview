#!/usr/bin/env python3
import argparse
import json
from datetime import datetime
from pathlib import Path

REQUIRED = [
    "model_id",
    "source_url",
    "code_license",
    "weights_license",
    "commercial_use_allowed",
    "attribution_required",
    "evidence_links",
    "checksum",
    "created_at",
]


def _is_datetime(value: str) -> bool:
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
        return True
    except ValueError:
        return False


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate voice weights manifest")
    parser.add_argument("manifest", nargs="?", default="configs/voice/weights-manifest.example.json")
    args = parser.parse_args()

    manifest_path = Path(args.manifest)
    if not manifest_path.exists():
        print(f"[weights-manifest] error=manifest_not_found path={manifest_path}")
        return 2

    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        print(f"[weights-manifest] error=invalid_json detail={exc}")
        return 3

    for key in REQUIRED:
        if key not in payload:
            print(f"[weights-manifest] error=missing_field field={key}")
            return 4

    if not isinstance(payload["commercial_use_allowed"], bool):
        print("[weights-manifest] error=invalid_type field=commercial_use_allowed expected=bool")
        return 5
    if payload["commercial_use_allowed"] is not True:
        print("[weights-manifest] error=commercial_use_required field=commercial_use_allowed expected=true")
        return 9
    if not isinstance(payload["attribution_required"], bool):
        print("[weights-manifest] error=invalid_type field=attribution_required expected=bool")
        return 6
    if not isinstance(payload["evidence_links"], list) or not payload["evidence_links"]:
        print("[weights-manifest] error=invalid_field field=evidence_links expected=non_empty_array")
        return 7
    if not isinstance(payload["created_at"], str) or not _is_datetime(payload["created_at"]):
        print("[weights-manifest] error=invalid_field field=created_at expected=rfc3339")
        return 8

    print("[weights-manifest] status=ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
