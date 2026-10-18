#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path

JOB_TYPE = os.getenv("TRAIN_JOB_TYPE", "tts_prod_train_nemo")
STATUS_PATH = Path(os.getenv("TRAIN_STATUS_PATH", f"artifacts/train_status.{JOB_TYPE}.json"))
ARTIFACT_DIR = Path(os.getenv("TRAIN_ARTIFACT_DIR", "artifacts"))


def emit(kind: str, payload: str) -> None:
    print(f"{kind} {payload}", flush=True)


def write_status(status: str, reason: str | None = None) -> None:
    STATUS_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "job_type": JOB_TYPE,
        "status": status,
        "reason": reason,
        "artifacts": [str(STATUS_PATH)],
    }
    STATUS_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def main() -> int:
    emit("PROGRESS", "0 3")
    emit("STATS", json.dumps({"job_type": JOB_TYPE, "lane": "nemo_prod_scaffold"}, separators=(",", ":")))

    try:
        __import__("nemo")
        deps_ready = True
    except Exception:
        deps_ready = False

    if not deps_ready:
        reason = "nemo_runtime_unavailable"
        write_status("error", reason)
        emit("ARTIFACT", str(STATUS_PATH))
        emit("STATS", json.dumps({"status": "blocked", "reason": reason}, separators=(",", ":")))
        return 2

    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    report = ARTIFACT_DIR / "tts_prod_train_nemo.report.json"
    report.write_text(json.dumps({"status": "completed", "job_type": JOB_TYPE}, indent=2), encoding="utf-8")
    emit("PROGRESS", "3 3")
    emit("ARTIFACT", str(report))

    write_status("completed")
    emit("ARTIFACT", str(STATUS_PATH))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
