#!/usr/bin/env python3
"""Deterministic Colab voice-train orchestrator with final report output.

This wrapper keeps control-flow logic out of prompts and always emits a final
report block, even on failure.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, Optional


REPO_ROOT = Path(__file__).resolve().parents[2]
AUX_ARTIFACTS_DIR = REPO_ROOT / "artifacts"
AUDIO_PATH = REPO_ROOT / "data/knowledge_audio_source/auntie_dottie.flac"
MANIFEST_PATH = REPO_ROOT / "external/audiocraft/data/knowledge_audio/voice_dataset_manifest.json"
STATUS_PATH = REPO_ROOT / "external/audiocraft/checkpoints/train_status.json"
CKPT_PATH = REPO_ROOT / "checkpoints/tts_voice_train_musicgen_small.pt"
BOOTSTRAP_PATH = REPO_ROOT / "scripts/voice/bootstrap_colab_train.sh"


def _tail(text: str, lines: int = 20) -> str:
    chunks = text.strip().splitlines()
    return "\n".join(chunks[-lines:]) if chunks else ""


def _run(step: str, cmd: list[str], env: Optional[Dict[str, str]] = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        cwd=str(REPO_ROOT),
        env=env,
        text=True,
        capture_output=True,
        check=True,
    )


def _sha256(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def _load_json(path: Path) -> Optional[Any]:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _is_finite_number(value: Any) -> bool:
    if isinstance(value, bool):
        return False
    if not isinstance(value, (int, float, str)):
        return False
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return False
    return math.isfinite(numeric)


def _emit_report(report: Dict[str, Any]) -> None:
    print("=== COLAB TRAIN REPORT ===")
    ordered_keys = [
        "objective_status",
        "first_failed_step",
        "root_cause",
        "head_commit",
        "python_version",
        "gpu_available",
        "audio_path",
        "audio_exists",
        "audio_size_bytes",
        "audio_is_lfs_pointer",
        "manifest_path",
        "manifest_exists",
        "manifest_entry_count",
        "training_status_path",
        "training_status_json",
        "checkpoint_path",
        "checkpoint_exists",
        "checkpoint_size_bytes",
        "checkpoint_sha256",
        "next_unblock_action",
    ]
    for key in ordered_keys:
        print(f"{key}: {report.get(key)}")


def main() -> int:
    report: Dict[str, Any] = {
        "objective_status": "blocked",
        "first_failed_step": "none",
        "root_cause": "none",
        "head_commit": "N/A",
        "python_version": sys.version.split()[0],
        "gpu_available": False,
        "audio_path": "data/knowledge_audio_source/auntie_dottie.flac",
        "audio_exists": False,
        "audio_size_bytes": "N/A",
        "audio_is_lfs_pointer": "N/A",
        "manifest_path": "external/audiocraft/data/knowledge_audio/voice_dataset_manifest.json",
        "manifest_exists": False,
        "manifest_entry_count": "N/A",
        "training_status_path": "external/audiocraft/checkpoints/train_status.json",
        "training_status_json": "N/A",
        "checkpoint_path": "checkpoints/tts_voice_train_musicgen_small.pt",
        "checkpoint_exists": False,
        "checkpoint_size_bytes": "N/A",
        "checkpoint_sha256": "N/A",
        "next_unblock_action": "none",
    }

    try:
        # Start from clean outputs by default to avoid stale report artifacts.
        if os.environ.get("CLEAR_PREVIOUS_ARTIFACTS", "1") == "1":
            report["first_failed_step"] = "reset_outputs"
            for path in (
                MANIFEST_PATH,
                STATUS_PATH,
                CKPT_PATH,
                AUX_ARTIFACTS_DIR / "colab_bootstrap_stdout.log",
                AUX_ARTIFACTS_DIR / "colab_bootstrap_stderr.log",
            ):
                if path.exists():
                    path.unlink()

        # Optional sync for environments with network access.
        if os.environ.get("RUN_GIT_SYNC", "0") == "1":
            report["first_failed_step"] = "git_fetch"
            _run("git_fetch", ["git", "fetch", "origin", "main"])
            report["first_failed_step"] = "git_checkout"
            _run("git_checkout", ["git", "checkout", "main"])
            report["first_failed_step"] = "git_pull"
            _run("git_pull", ["git", "pull", "--rebase", "origin", "main"])

        report["first_failed_step"] = "read_head_commit"
        cp = _run("read_head_commit", ["git", "rev-parse", "--short=8", "HEAD"])
        report["head_commit"] = cp.stdout.strip()

        # GPU detection (GPU required by default for this experimental smoke lane).
        report["first_failed_step"] = "gpu_probe"
        allow_cpu_smoke = os.environ.get("ALLOW_CPU_SMOKE", "0") == "1"
        if shutil.which("nvidia-smi") is None:
            report["gpu_available"] = False
        else:
            nvidia = subprocess.run(
                ["nvidia-smi"],
                cwd=str(REPO_ROOT),
                text=True,
                capture_output=True,
                check=False,
            )
            report["gpu_available"] = nvidia.returncode == 0

        if not report["gpu_available"] and not allow_cpu_smoke:
            report["objective_status"] = "failed"
            report["root_cause"] = "gpu_required_for_colab_smoke_lane"
            report["next_unblock_action"] = "attach a GPU runtime or set ALLOW_CPU_SMOKE=1 for explicit CPU override"
            return 1

        # Audio preflight.
        report["first_failed_step"] = "audio_preflight"
        if not AUDIO_PATH.exists():
            raise RuntimeError(f"missing audio file at {AUDIO_PATH}")
        report["audio_exists"] = True
        report["audio_size_bytes"] = AUDIO_PATH.stat().st_size
        head = AUDIO_PATH.read_bytes()[:200]
        is_lfs = b"git-lfs.github.com/spec/v1" in head
        report["audio_is_lfs_pointer"] = is_lfs
        if report["audio_size_bytes"] <= 5_000_000:
            raise RuntimeError("audio file is too small; expected >5MB")
        if is_lfs:
            raise RuntimeError("audio path points to git-lfs pointer, not real audio")

        # Bootstrap owns install + prepare + train.
        report["first_failed_step"] = "bootstrap_colab_train"
        env = os.environ.copy()
        env["AUDIO_PATH"] = env.get("AUDIO_PATH", "data/knowledge_audio_source/auntie_dottie.flac")
        env["SOURCE_DIR"] = env.get("SOURCE_DIR", "data/knowledge_audio_source")
        env["KNOWLEDGE_SOURCE_DIR"] = env.get("KNOWLEDGE_SOURCE_DIR", env["SOURCE_DIR"])
        env["KNOWLEDGE_AUDIO_DIR"] = env.get("KNOWLEDGE_AUDIO_DIR", "external/audiocraft/data/knowledge_audio")
        env["TRAIN_STATUS_PATH"] = env.get("TRAIN_STATUS_PATH", "external/audiocraft/checkpoints/train_status.json")
        env["INSTALL_AUDIOCRAFT_EDITABLE"] = env.get("INSTALL_AUDIOCRAFT_EDITABLE", "auto")
        env["RESET_TRAIN_OUTPUTS"] = env.get("RESET_TRAIN_OUTPUTS", "1")
        env["EFFICIENT_ATTENTION_BACKEND"] = env.get("EFFICIENT_ATTENTION_BACKEND", "torch")
        _run("bootstrap_colab_train", ["bash", str(BOOTSTRAP_PATH)], env=env)

        # Artifact collection.
        report["first_failed_step"] = "collect_artifacts"
        manifest = _load_json(MANIFEST_PATH)
        report["manifest_exists"] = MANIFEST_PATH.exists()
        if isinstance(manifest, dict):
            report["manifest_entry_count"] = len(manifest.get("entries", []))

        status = _load_json(STATUS_PATH)
        if status is not None:
            report["training_status_json"] = json.dumps(status, ensure_ascii=False)

        report["checkpoint_exists"] = CKPT_PATH.exists()
        if CKPT_PATH.exists():
            report["checkpoint_size_bytes"] = CKPT_PATH.stat().st_size
            report["checkpoint_sha256"] = _sha256(CKPT_PATH)

        # Candidate completion before strict gate validation.
        report["objective_status"] = "completed"

        # Deterministic strict acceptance gates (first failure wins).
        gate_failures = [
            (
                report.get("objective_status") == "completed",
                "objective_status_gate",
                f"objective_status_must_be_completed: got={report.get('objective_status')}",
                "ensure the wrapper reaches completion path before artifact validation",
            ),
            (
                STATUS_PATH.exists(),
                "train_status_exists_gate",
                f"missing_train_status_json:{STATUS_PATH}",
                "inspect bootstrap logs and ensure training emits train_status.json",
            ),
            (
                isinstance(status, dict) and status.get("status") == "completed",
                "train_status_completed_gate",
                f"train_status_not_completed: got={status.get('status') if isinstance(status, dict) else type(status).__name__}",
                "resolve training error and rerun",
            ),
            (
                isinstance(status, dict) and "loss" in status and _is_finite_number(status.get("loss")),
                "loss_finite_gate",
                f"loss_missing_or_non_finite: loss={status.get('loss') if isinstance(status, dict) else 'N/A'}",
                "keep non-finite loss hard-fail behavior and rerun after fix",
            ),
            (
                CKPT_PATH.exists() and CKPT_PATH.stat().st_size > 0,
                "checkpoint_nonempty_gate",
                f"checkpoint_missing_or_empty:{CKPT_PATH}",
                "ensure training writes a non-empty checkpoint",
            ),
        ]

        for ok, step, cause, action in gate_failures:
            if not ok:
                report["objective_status"] = "failed"
                report["first_failed_step"] = step
                report["root_cause"] = cause
                report["next_unblock_action"] = action
                break
        else:
            report["objective_status"] = "completed"
            report["first_failed_step"] = "none"
            report["root_cause"] = "none"
            report["next_unblock_action"] = "none"

    except subprocess.CalledProcessError as exc:
        AUX_ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)
        stdout_log = AUX_ARTIFACTS_DIR / "colab_bootstrap_stdout.log"
        stderr_log = AUX_ARTIFACTS_DIR / "colab_bootstrap_stderr.log"
        stdout_log.write_text(exc.stdout or "", encoding="utf-8")
        stderr_log.write_text(exc.stderr or "", encoding="utf-8")
        report["objective_status"] = "failed"
        report["root_cause"] = (
            f"command failed ({exc.returncode}): {' '.join(exc.cmd)} | "
            f"stdout_tail={_tail(exc.stdout)} | stderr_tail={_tail(exc.stderr)} | "
            f"stdout_log={stdout_log} | stderr_log={stderr_log}"
        )
        report["next_unblock_action"] = "fix first_failed_step command and rerun"
    except Exception as exc:  # noqa: BLE001
        report["objective_status"] = "failed"
        report["root_cause"] = str(exc)
        report["next_unblock_action"] = "resolve reported root_cause and rerun"
    finally:
        # Ensure status fields reflect current filesystem even on failure.
        report["audio_exists"] = AUDIO_PATH.exists()
        if AUDIO_PATH.exists():
            report["audio_size_bytes"] = AUDIO_PATH.stat().st_size
            report["audio_is_lfs_pointer"] = b"git-lfs.github.com/spec/v1" in AUDIO_PATH.read_bytes()[:200]
        report["manifest_exists"] = MANIFEST_PATH.exists()
        if report["manifest_exists"] and report["manifest_entry_count"] == "N/A":
            manifest = _load_json(MANIFEST_PATH)
            if isinstance(manifest, dict):
                report["manifest_entry_count"] = len(manifest.get("entries", []))
        if report["training_status_json"] == "N/A":
            status = _load_json(STATUS_PATH)
            if status is not None:
                report["training_status_json"] = json.dumps(status, ensure_ascii=False)
        report["checkpoint_exists"] = CKPT_PATH.exists()
        if report["checkpoint_exists"] and report["checkpoint_size_bytes"] == "N/A":
            report["checkpoint_size_bytes"] = CKPT_PATH.stat().st_size
            report["checkpoint_sha256"] = _sha256(CKPT_PATH)
        _emit_report(report)

    return 0 if report["objective_status"] == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
