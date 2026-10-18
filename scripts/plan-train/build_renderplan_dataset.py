#!/usr/bin/env python3
"""
Build a RenderPlan training dataset from stems + metadata.
"""
from __future__ import annotations

import argparse
import json
import math
import wave
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np


DEFAULT_BPM = 120.0
DEFAULT_TIME_SIG = "4/4"
MAX_SEGMENT_SAMPLES = 48_000
CUTOFF_HZ = 1_000.0


def read_json(path: Path) -> Optional[Dict[str, Any]]:
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:
        return None


def normalize_time_sig(value: str | None) -> Tuple[str, int]:
    if not value:
        return DEFAULT_TIME_SIG, 4
    parts = value.split("/")
    if len(parts) != 2:
        return DEFAULT_TIME_SIG, 4
    try:
        num = max(1, int(parts[0]))
    except Exception:
        num = 4
    return f"{num}/{parts[1]}", num


def load_wav_mono(path: Path) -> Tuple[int, np.ndarray]:
    with wave.open(str(path), "rb") as handle:
        channels = handle.getnchannels()
        sampwidth = handle.getsampwidth()
        framerate = handle.getframerate()
        frames = handle.readframes(handle.getnframes())

    dtype_map = {1: np.int8, 2: np.int16, 4: np.int32}
    if sampwidth not in dtype_map:
        raise ValueError(f"Unsupported wav sample width: {sampwidth}")
    dtype = dtype_map[sampwidth]
    data = np.frombuffer(frames, dtype=dtype).astype(np.float32)
    if channels > 1:
        data = data.reshape(-1, channels).mean(axis=1)
    scale = float(np.iinfo(dtype).max)
    if scale > 0:
        data = data / scale
    return framerate, data


def compute_bar_features(
    samples: np.ndarray,
    sample_rate: int,
    bpm: float,
    beats_per_bar: int,
    max_bar: int,
) -> Tuple[List[float], List[float], List[float]]:
    seconds_per_bar = (60.0 / max(1e-3, bpm)) * beats_per_bar
    samples_per_bar = max(1, int(seconds_per_bar * sample_rate))
    rms_values: List[float] = []
    density_values: List[float] = []
    brightness_values: List[float] = []

    for bar in range(max_bar):
        start = bar * samples_per_bar
        end = min(len(samples), start + samples_per_bar)
        segment = samples[start:end]
        if segment.size == 0:
            rms_values.append(0.0)
            density_values.append(0.0)
            brightness_values.append(0.0)
            continue
        if segment.size > MAX_SEGMENT_SAMPLES:
            stride = int(math.ceil(segment.size / MAX_SEGMENT_SAMPLES))
            segment = segment[::stride]

        rms = float(np.sqrt(np.mean(segment * segment)))
        diff = np.diff(segment)
        density = float(np.mean(np.abs(diff))) if diff.size else 0.0

        spectrum = np.abs(np.fft.rfft(segment))
        freqs = np.fft.rfftfreq(segment.size, 1.0 / sample_rate)
        high = float(np.sum(spectrum[freqs >= CUTOFF_HZ]))
        low = float(np.sum(spectrum[freqs < CUTOFF_HZ]))
        brightness = high / (high + low) if (high + low) > 0 else 0.0

        rms_values.append(rms)
        density_values.append(density)
        brightness_values.append(brightness)

    return rms_values, density_values, brightness_values


def normalize_series(values: List[float]) -> List[float]:
    if not values:
        return []
    min_val = min(values)
    max_val = max(values)
    if not math.isfinite(min_val) or not math.isfinite(max_val) or max_val <= min_val:
        return [0.5 for _ in values]
    scale = max_val - min_val
    return [max(0.0, min(1.0, (val - min_val) / scale)) for val in values]


def resolve_marker_start_bar(marker: Dict[str, Any], beats_per_bar: int) -> Optional[int]:
    for key in ("startBar", "bar", "barStart", "start_bar"):
        if key in marker:
            try:
                return max(1, int(marker[key]))
            except Exception:
                pass
    for key in ("startBeat", "beat", "position"):
        if key in marker:
            try:
                beat = float(marker[key])
                return max(1, int(math.floor(beat / beats_per_bar)) + 1)
            except Exception:
                pass
    return None


def parse_sections(meta: Dict[str, Any], beats_per_bar: int, max_bar: int) -> List[Dict[str, Any]]:
    sections: List[Dict[str, Any]] = []
    candidates = []
    for key in ("sections", "locators", "markers"):
        if isinstance(meta.get(key), list):
            candidates.extend(meta[key])
    for key in ("arrangement", "session"):
        block = meta.get(key)
        if isinstance(block, dict):
            for subkey in ("sections", "locators", "markers"):
                if isinstance(block.get(subkey), list):
                    candidates.extend(block[subkey])
    markers: List[Tuple[int, str, Optional[int]]] = []
    for entry in candidates:
        if not isinstance(entry, dict):
            continue
        start_bar = resolve_marker_start_bar(entry, beats_per_bar)
        if start_bar is None:
            continue
        name = str(entry.get("name") or entry.get("label") or "section").strip()
        bars = entry.get("bars") or entry.get("lengthBars") or entry.get("durationBars")
        bar_len = None
        if bars is not None:
            try:
                bar_len = max(1, int(bars))
            except Exception:
                bar_len = None
        markers.append((start_bar, name, bar_len))
    markers.sort(key=lambda item: item[0])
    for index, (start_bar, name, bar_len) in enumerate(markers):
        end_bar = max_bar + 1
        if index + 1 < len(markers):
            end_bar = markers[index + 1][0]
        bars = bar_len if bar_len is not None else max(1, end_bar - start_bar)
        sections.append({"name": name, "startBar": start_bar, "bars": bars})
    return sections


def aggregate_windows(
    windows: List[Dict[str, Any]],
    energy: List[float],
    density: List[float],
    brightness: List[float],
) -> List[Dict[str, Any]]:
    results = []
    for window in windows:
        start = max(1, int(window["startBar"]))
        bars = max(1, int(window["bars"]))
        start_idx = max(0, start - 1)
        end_idx = min(len(energy), start_idx + bars)
        if end_idx <= start_idx:
            continue
        slice_energy = energy[start_idx:end_idx]
        slice_density = density[start_idx:end_idx]
        slice_brightness = brightness[start_idx:end_idx]
        results.append(
            {
                "startBar": start,
                "bars": bars,
                "energy": float(sum(slice_energy) / len(slice_energy)),
                "density": float(sum(slice_density) / len(slice_density)),
                "brightness": float(sum(slice_brightness) / len(slice_brightness)),
            }
        )
    return results


def discover_track_dirs(root: Path) -> List[Path]:
    tracks_dir = root / "tracks"
    if not tracks_dir.exists():
        return []
    return [path for path in tracks_dir.iterdir() if path.is_dir()]


def load_manifest(root: Path) -> List[Dict[str, Any]]:
    manifest_path = root / "manifest.jsonl"
    if not manifest_path.exists():
        return []
    entries: List[Dict[str, Any]] = []
    with manifest_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except Exception:
                continue
    return entries


def resolve_track_inputs(root: Path, entry: Dict[str, Any]) -> Dict[str, Path | None]:
    track_dir = root / "tracks" / str(entry.get("id", "")).strip()
    stems_dir = Path(entry.get("stems", "")) if entry.get("stems") else track_dir / "stems"
    metadata_path = Path(entry.get("metadata", "")) if entry.get("metadata") else track_dir / "metadata" / "ableton.json"
    tempo_path = Path(entry.get("tempo", "")) if entry.get("tempo") else track_dir / "metadata" / "tempo.json"
    plan_path = Path(entry.get("render_plan", "")) if entry.get("render_plan") else track_dir / "render_plan.json"
    return {
        "track_dir": track_dir,
        "stems_dir": stems_dir,
        "metadata_path": metadata_path,
        "tempo_path": tempo_path,
        "plan_path": plan_path,
    }


def pick_instrumental(stems_dir: Path) -> Optional[Path]:
    if stems_dir.is_file():
        return stems_dir
    if not stems_dir.exists():
        return None
    candidate = stems_dir / "instrumental.wav"
    if candidate.exists():
        return candidate
    wavs = list(stems_dir.glob("*.wav"))
    return wavs[0] if wavs else None


def build_example(root: Path, entry: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    paths = resolve_track_inputs(root, entry)
    plan = read_json(Path(paths["plan_path"])) if paths["plan_path"] else None
    if not plan:
        return None
    windows = plan.get("windows") if isinstance(plan.get("windows"), list) else None
    if not windows:
        return None

    tempo_payload = read_json(Path(paths["tempo_path"])) if paths["tempo_path"] else None
    plan_global = plan.get("global") if isinstance(plan.get("global"), dict) else {}
    bpm = float(tempo_payload.get("bpm")) if isinstance(tempo_payload, dict) and tempo_payload.get("bpm") else float(plan_global.get("bpm") or DEFAULT_BPM)
    time_sig, beats_per_bar = normalize_time_sig(
        str(tempo_payload.get("timeSig")) if isinstance(tempo_payload, dict) else None
    )
    tempo = {"bpm": bpm, "timeSig": time_sig, "offsetMs": 0}

    max_bar = 1
    for window in windows:
        try:
            start = int(window["startBar"])
            bars = int(window.get("bars", 1))
            max_bar = max(max_bar, start + max(1, bars) - 1)
        except Exception:
            continue

    instrumental_path = pick_instrumental(Path(paths["stems_dir"]))
    if not instrumental_path:
        return None

    try:
        sample_rate, samples = load_wav_mono(instrumental_path)
    except Exception:
        return None

    rms, density, brightness = compute_bar_features(
        samples, sample_rate, bpm, beats_per_bar, max_bar
    )
    energy_by_bar = normalize_series(rms)
    density_by_bar = normalize_series(density)
    brightness_by_bar = normalize_series(brightness)
    analysis_windows = aggregate_windows(windows, energy_by_bar, density_by_bar, brightness_by_bar)

    meta = read_json(Path(paths["metadata_path"])) if paths["metadata_path"] else None
    sections = parse_sections(meta, beats_per_bar, max_bar) if isinstance(meta, dict) else []
    energy_curve = [{"bar": idx + 1, "energy": energy} for idx, energy in enumerate(energy_by_bar)]

    analysis = {
        "windows": analysis_windows,
        "energyByBar": energy_by_bar,
        "densityByBar": density_by_bar,
        "brightnessByBar": brightness_by_bar,
        "sections": sections if sections else None,
        "energyCurve": energy_curve,
    }
    return {
        "id": entry.get("id") or paths["track_dir"].name,
        "tempo": tempo,
        "analysis": analysis,
        "target": plan,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Build RenderPlan training dataset.")
    parser.add_argument("--root", required=True, help="Dataset root directory.")
    parser.add_argument("--out", required=True, help="Output JSONL path.")
    args = parser.parse_args()

    root = Path(args.root)
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    manifest = load_manifest(root)
    entries: List[Dict[str, Any]] = manifest
    if not entries:
        entries = [{"id": path.name} for path in discover_track_dirs(root)]

    count = 0
    with out_path.open("w", encoding="utf-8") as handle:
        for entry in entries:
            record = build_example(root, entry)
            if not record:
                continue
            handle.write(json.dumps(record) + "\n")
            count += 1

    print(f"Wrote {count} examples to {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
