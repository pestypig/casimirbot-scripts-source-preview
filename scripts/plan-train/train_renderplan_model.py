#!/usr/bin/env python3
"""
Train a lightweight RenderPlan regression model from dataset JSONL.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict, List, Tuple

import numpy as np


SECTION_ORDER = ["intro", "verse", "build", "drop", "bridge", "outro"]
FEATURE_NAMES = [
    "energy",
    "density",
    "brightness",
    "start_norm",
    "bars_norm",
    "bpm_norm",
] + [f"section_{name}" for name in SECTION_ORDER]


TARGET_FIELDS = {
    "sampleInfluence": ("texture", "sampleInfluence"),
    "styleInfluence": ("texture", "styleInfluence"),
    "weirdness": ("texture", "weirdness"),
    "fx.chorus": ("texture", "fx", "chorus"),
    "fx.sat": ("texture", "fx", "sat"),
    "fx.reverbSend": ("texture", "fx", "reverbSend"),
    "fx.comp": ("texture", "fx", "comp"),
}


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
    section_features = [
        1.0 if section_name == name else 0.0 for name in SECTION_ORDER
    ]

    return [
        clamp01(float(energy)),
        clamp01(float(density)),
        clamp01(float(brightness)),
        float(start_norm),
        float(bars_norm),
        float(bpm_norm),
        *section_features,
    ]


def extract_target_value(window: Dict[str, Any], path: Tuple[str, ...]) -> float | None:
    node: Any = window
    for key in path:
        if not isinstance(node, dict) or key not in node:
            return None
        node = node[key]
    try:
        value = float(node)
    except Exception:
        return None
    return clamp01(value) if path[0] == "texture" else value


def fit_linear_model(x: np.ndarray, y: np.ndarray, l2: float) -> Tuple[np.ndarray, float]:
    ones = np.ones((x.shape[0], 1), dtype=np.float32)
    x_aug = np.concatenate([x, ones], axis=1)
    eye = np.eye(x_aug.shape[1], dtype=np.float32)
    eye[-1, -1] = 0.0
    lhs = x_aug.T @ x_aug + l2 * eye
    rhs = x_aug.T @ y
    weights = np.linalg.solve(lhs, rhs)
    return weights[:-1], float(weights[-1])


def main() -> int:
    parser = argparse.ArgumentParser(description="Train RenderPlan regression model.")
    parser.add_argument("--dataset", required=True, help="Dataset JSONL path.")
    parser.add_argument("--out", required=True, help="Output model JSON path.")
    parser.add_argument("--l2", type=float, default=1e-3, help="L2 regularization.")
    args = parser.parse_args()

    targets_x: Dict[str, List[List[float]]] = {key: [] for key in TARGET_FIELDS}
    targets_y: Dict[str, List[float]] = {key: [] for key in TARGET_FIELDS}
    example_count = 0

    with Path(args.dataset).open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            record = json.loads(line)
            analysis = record.get("analysis") or {}
            tempo = record.get("tempo") or {}
            target = record.get("target") or {}
            windows = target.get("windows") or []
            if not windows:
                continue
            max_bar = max(
                [int(window.get("startBar", 1)) + int(window.get("bars", 1)) - 1 for window in windows]
                or [1]
            )
            for window in windows:
                features = extract_window_features(analysis, tempo, window, max_bar)
                for name, path in TARGET_FIELDS.items():
                    value = extract_target_value(window, path)
                    if value is None:
                        continue
                    targets_x[name].append(features)
                    targets_y[name].append(value)
            example_count += 1

    model: Dict[str, Any] = {
        "version": 1,
        "featureNames": FEATURE_NAMES,
        "targets": {},
        "examples": example_count,
    }

    for name, x_rows in targets_x.items():
        if not x_rows:
            continue
        x = np.array(x_rows, dtype=np.float32)
        y = np.array(targets_y[name], dtype=np.float32)
        weights, bias = fit_linear_model(x, y, args.l2)
        model["targets"][name] = {
            "weights": [float(val) for val in weights],
            "bias": float(bias),
            "count": int(len(y)),
        }

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as handle:
        json.dump(model, handle, indent=2)

    print(f"Saved model to {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
