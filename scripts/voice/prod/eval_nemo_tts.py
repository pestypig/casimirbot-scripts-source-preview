#!/usr/bin/env python3
import json
import math
import os
from pathlib import Path

STATUS_PATH = Path(os.getenv("PROD_TTS_STATUS_PATH", "artifacts/prod_tts_train_status.json"))
EVAL_PATH = Path(os.getenv("PROD_TTS_EVAL_PATH", "artifacts/prod_tts_eval.json"))


def emit(kind: str, payload: str) -> None:
    print(f"{kind} {payload}", flush=True)


def main() -> int:
    emit("PROGRESS", "0 1")
    if not STATUS_PATH.exists():
        emit("STATS", '{"status":"blocked","root_cause":"missing_train_status"}')
        return 2

    train_status = json.loads(STATUS_PATH.read_text(encoding="utf-8"))
    metrics = train_status.get("metrics") or {}
    final_loss = metrics.get("final_loss")
    if final_loss is None:
        final_loss = 0.0 if bool(train_status.get("dry_run")) else float("inf")
    try:
        final_loss_value = float(final_loss)
    except Exception:
        final_loss_value = float("inf")

    if not math.isfinite(final_loss_value):
        evaluation = {
            "status": "blocked",
            "mos_proxy": None,
            "wer_proxy": None,
            "root_cause": "non_finite_final_loss",
            "source_status": str(STATUS_PATH),
        }
        EVAL_PATH.parent.mkdir(parents=True, exist_ok=True)
        EVAL_PATH.write_text(json.dumps(evaluation, indent=2, sort_keys=True), encoding="utf-8")
        emit("STATS", json.dumps(evaluation, sort_keys=True, separators=(",", ":")))
        emit("ARTIFACT", str(EVAL_PATH))
        emit("PROGRESS", "1 1")
        return 3

    mos_proxy = max(1.0, min(5.0, 5.0 - min(final_loss_value, 4.0)))
    wer_proxy = max(0.0, min(1.0, final_loss_value / 10.0))
    evaluation = {
        "status": "ok" if train_status.get("status") == "ok" else "blocked",
        "mos_proxy": mos_proxy if train_status.get("status") == "ok" else None,
        "wer_proxy": wer_proxy if train_status.get("status") == "ok" else None,
        "root_cause": "none" if train_status.get("status") == "ok" else train_status.get("root_cause", "train_not_ready"),
        "final_loss": final_loss_value if train_status.get("status") == "ok" else None,
        "source_status": str(STATUS_PATH),
    }
    EVAL_PATH.parent.mkdir(parents=True, exist_ok=True)
    EVAL_PATH.write_text(json.dumps(evaluation, indent=2, sort_keys=True), encoding="utf-8")
    emit("STATS", json.dumps(evaluation, sort_keys=True, separators=(",", ":")))
    emit("ARTIFACT", str(EVAL_PATH))
    emit("PROGRESS", "1 1")
    return 0 if evaluation["status"] == "ok" else 3


if __name__ == "__main__":
    raise SystemExit(main())
