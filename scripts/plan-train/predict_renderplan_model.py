#!/usr/bin/env python3
"""
Generate a RenderPlan from analysis using a trained model.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict, List

import numpy as np


SECTION_ORDER = ["intro", "verse", "build", "drop", "bridge", "outro"]


def clamp01(value: float) -> float:
    if not np.isfinite(value):
        return 0.0
    return float(max(0.0, min(1.0, value)))


def window_key(window: Dict[str, Any]) -> str:
    return f"{int(window.get('startBar', 1))}:{int(window.get('bars', 1))}"


def resolve_section(window: Dict[str, Any], sections: List[Dict[str, Any]]) -> str | None:
    start_bar = int(window.get("startBar", 1))
    for section in sections:
        try:
            sec_start = int(section.get("startBar", 1))
            sec_bars = int(section.get("bars", 1))
        except Exception:
            continue
        if start_bar >= sec_start and start_bar < sec_start + max(1, sec_bars):
            name = str(section.get("name") or "").strip().lower()
            return name if name else None
    return None


def average_series(series: List[float], start_bar: int, bars: int) -> float:
    if not series:
        return 0.5
    start = max(0, start_bar - 1)
    end = min(len(series), start + max(1, bars))
    if end <= start:
        return 0.5
    return float(sum(series[start:end]) / (end - start))


def extract_window_features(
    analysis: Dict[str, Any],
    tempo: Dict[str, Any],
    window: Dict[str, Any],
    max_bar: int,
    feature_names: List[str],
) -> List[float]:
    start_bar = int(window.get("startBar", 1))
    bars = int(window.get("bars", 1))
    energy_by_bar = analysis.get("energyByBar") or []
    density_by_bar = analysis.get("densityByBar") or []
    brightness_by_bar = analysis.get("brightnessByBar") or []

    window_map = {window_key(w): w for w in analysis.get("windows") or []}
    window_features = window_map.get(window_key(window), {})
    energy = window_features.get("energy")
    density = window_features.get("density")
    brightness = window_features.get("brightness")

    if energy is None:
        energy = average_series(energy_by_bar, start_bar, bars)
    if density is None:
        density = average_series(density_by_bar, start_bar, bars)
    if brightness is None:
        brightness = average_series(brightness_by_bar, start_bar, bars)

    bpm = float(tempo.get("bpm", 120))
    start_norm = start_bar / max(1.0, max_bar)
    bars_norm = bars / max(1.0, max_bar)
    bpm_norm = bpm / 240.0
    section_name = resolve_section(window, analysis.get("sections") or [])

    feature_values = {
        "energy": clamp01(float(energy)),
        "density": clamp01(float(density)),
        "brightness": clamp01(float(brightness)),
        "start_norm": float(start_norm),
        "bars_norm": float(bars_norm),
        "bpm_norm": float(bpm_norm),
    }
    for name in SECTION_ORDER:
        feature_values[f"section_{name}"] = 1.0 if section_name == name else 0.0

    return [float(feature_values.get(name, 0.0)) for name in feature_names]


def apply_model(
    model: Dict[str, Any],
    analysis: Dict[str, Any],
    tempo: Dict[str, Any],
) -> Dict[str, Any]:
    feature_names = model.get("featureNames") or []
    targets = model.get("targets") or {}
    windows = analysis.get("windows") or []
    if not windows:
        raise ValueError("Analysis must include windows to generate a plan.")
    max_bar = max(
        [int(window.get("startBar", 1)) + int(window.get("bars", 1)) - 1 for window in windows]
        or [1]
    )
    plan_windows = []
    for window in windows:
        feature_vec = extract_window_features(analysis, tempo, window, max_bar, feature_names)
        predictions: Dict[str, float] = {}
        for name, entry in targets.items():
            weights = np.array(entry.get("weights") or [], dtype=np.float32)
            bias = float(entry.get("bias") or 0.0)
            if weights.size != len(feature_vec):
                continue
            value = float(np.dot(weights, feature_vec) + bias)
            predictions[name] = clamp01(value)
        texture: Dict[str, Any] = {}
        fx: Dict[str, Any] = {}
        for key, value in predictions.items():
            if key.startswith("fx."):
                fx_key = key.split(".", 1)[1]
                fx[fx_key] = value
            else:
                texture[key] = value
        if fx:
            texture["fx"] = fx
        plan_windows.append(
            {
                "startBar": int(window.get("startBar", 1)),
                "bars": int(window.get("bars", 1)),
                "texture": texture,
            }
        )
    return {
        "global": {
            "bpm": tempo.get("bpm"),
            "sections": analysis.get("sections") or [],
            "energyCurve": analysis.get("energyCurve") or [],
        },
        "windows": plan_windows,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Predict RenderPlan from analysis.")
    parser.add_argument("--model", required=True, help="Model JSON path.")
    parser.add_argument("--analysis", required=True, help="Analysis JSON path.")
    parser.add_argument("--out", required=True, help="Output RenderPlan JSON path.")
    args = parser.parse_args()

    model = json.loads(Path(args.model).read_text(encoding="utf-8"))
    analysis_payload = json.loads(Path(args.analysis).read_text(encoding="utf-8"))
    analysis = analysis_payload.get("analysis") or analysis_payload
    tempo = analysis_payload.get("tempo") or {"bpm": 120, "timeSig": "4/4", "offsetMs": 0}
    plan = apply_model(model, analysis, tempo)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(plan, indent=2), encoding="utf-8")
    print(f"Wrote RenderPlan to {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
