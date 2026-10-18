#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from shutil import copy2, rmtree
from typing import Any


def emit(kind: str, payload: str) -> None:
    print(f"{kind} {payload}", flush=True)


def sha256_bytes(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def file_entry(path: Path, base: Path) -> dict[str, object]:
    return {
        "path": str(path.relative_to(base)),
        "bytes": path.stat().st_size,
        "sha256": sha256_file(path),
    }


SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def normalize_profile_id(raw: Any) -> str:
    if not isinstance(raw, str):
        raise RuntimeError("voice_profile_id_invalid")
    profile_id = raw.strip()
    if not profile_id:
        raise RuntimeError("voice_profile_id_invalid")
    if any(ch in profile_id for ch in ("/", "\\")) or ".." in profile_id:
        raise RuntimeError("voice_profile_id_invalid")
    return profile_id


def normalize_rel_path(raw: Any) -> Path:
    if not isinstance(raw, str) or not raw.strip():
        raise RuntimeError("source_file_path_invalid")
    canonical = raw.strip().replace("\\", "/")
    pure = PurePosixPath(canonical)
    if pure.is_absolute() or ".." in pure.parts:
        raise RuntimeError(f"source_file_path_escape:{canonical}")
    parts = [part for part in pure.parts if part not in ("", ".")]
    if not parts:
        raise RuntimeError("source_file_path_invalid")
    return Path(*parts)


def parse_expected_bytes(raw: Any) -> int:
    try:
        value = int(raw)
    except Exception as exc:
        raise RuntimeError("source_file_bytes_invalid") from exc
    if value < 0:
        raise RuntimeError("source_file_bytes_invalid")
    return value


def parse_expected_sha(raw: Any) -> str:
    value = str(raw).strip().lower()
    if not SHA256_RE.fullmatch(value):
        raise RuntimeError("source_file_sha_invalid")
    return value


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-manifest", default="checkpoints/prod_tts_voice_bundle/manifest.json")
    parser.add_argument("--output-root", default="bundles")
    parser.add_argument("--voice-profile-id", default="dottie_default")
    parser.add_argument("--display-name", default="Dottie")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    emit("PROGRESS", "0 2")

    source_manifest_path = Path(args.input_manifest)
    if not source_manifest_path.exists():
        raise RuntimeError("source_manifest_missing")

    source_manifest_raw = source_manifest_path.read_bytes()
    source_manifest = json.loads(source_manifest_raw.decode("utf-8"))
    if not isinstance(source_manifest, dict):
        raise RuntimeError("source_manifest_invalid")

    if source_manifest.get("bundle_version") != "prod_tts_voice_bundle/1":
        raise RuntimeError("unsupported_source_bundle_version")

    entries = source_manifest.get("files")
    if not isinstance(entries, list) or not entries:
        raise RuntimeError("source_manifest_files_invalid")

    profile_id = normalize_profile_id(args.voice_profile_id)
    source_dir = source_manifest_path.parent
    target_dir = Path(args.output_root) / profile_id / "voice_bundle"
    if target_dir.exists():
        rmtree(target_dir)
    target_dir.mkdir(parents=True, exist_ok=True)

    promoted_files: list[dict[str, object]] = []
    source_file_summaries: list[dict[str, object]] = []
    for idx, file_meta in enumerate(entries):
        if not isinstance(file_meta, dict):
            raise RuntimeError(f"source_manifest_file_entry_invalid:{idx}")
        rel_path = normalize_rel_path(file_meta.get("path"))
        expected_bytes = parse_expected_bytes(file_meta.get("bytes"))
        expected_sha = parse_expected_sha(file_meta.get("sha256"))
        source_file = source_dir / rel_path
        if not source_file.exists():
            raise RuntimeError(f"source_file_missing:{rel_path.as_posix()}")
        actual_bytes = source_file.stat().st_size
        if actual_bytes != expected_bytes:
            raise RuntimeError(f"source_file_bytes_mismatch:{rel_path.as_posix()}")
        actual_sha = sha256_file(source_file)
        if actual_sha != expected_sha:
            raise RuntimeError(f"source_file_checksum_mismatch:{rel_path.as_posix()}")
        dest_file = target_dir / rel_path
        dest_file.parent.mkdir(parents=True, exist_ok=True)
        copy2(source_file, dest_file)
        promoted_files.append(file_entry(dest_file, target_dir))
        source_file_summaries.append({
            "path": rel_path.as_posix(),
            "bytes": expected_bytes,
            "sha256": expected_sha,
        })

    promoted_manifest = {
        "bundle_version": "voice_bundle/1",
        "voice_profile_id": profile_id,
        "display_name": args.display_name,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "files": sorted(promoted_files, key=lambda entry: str(entry["path"])),
        "provenance": {
            "source_bundle_version": source_manifest.get("bundle_version"),
            "source_manifest_path": source_manifest_path.as_posix(),
            "source_manifest_sha256": sha256_bytes(source_manifest_raw),
            "source_commit": source_manifest.get("commit"),
            "source_config_sha256": source_manifest.get("config_sha256"),
            "source_dataset_sha256": source_manifest.get("dataset_sha256"),
            "source_weights_refs": source_manifest.get("weights_refs"),
            "source_artifact_sha256": source_manifest.get("artifact_sha256"),
            "source_files": sorted(source_file_summaries, key=lambda entry: str(entry["path"])),
        },
    }

    manifest_path = target_dir / "manifest.json"
    manifest_path.write_text(json.dumps(promoted_manifest, indent=2, sort_keys=True), encoding="utf-8")

    emit("STATS", json.dumps({
        "status": "ok",
        "source": source_manifest_path.as_posix(),
        "profile": profile_id,
        "files": len(promoted_files),
    }, sort_keys=True, separators=(",", ":")))
    emit("ARTIFACT", manifest_path.as_posix())
    emit("PROGRESS", "2 2")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
