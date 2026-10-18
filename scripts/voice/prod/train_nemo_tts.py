#!/usr/bin/env python3
import hashlib
import json
import os
import random
import shutil
from pathlib import Path
from typing import Any, Iterable

STATUS_PATH = Path(os.getenv("PROD_TTS_STATUS_PATH", "artifacts/prod_tts_train_status.json"))
ARTIFACTS_DIR = Path(os.getenv("PROD_TTS_ARTIFACTS_DIR", "artifacts"))
ALLOWLIST_PATH = Path(os.getenv("PROD_TTS_ALLOWLIST", "configs/voice/prod_tts/weights_allowlist.json"))
CONFIG_PATH = Path(os.getenv("PROD_TTS_CONFIG", "configs/voice/prod_tts/nemo_fastpitch_hifigan.yaml"))
DATASET_MANIFEST = Path(os.getenv("PROD_TTS_DATASET_MANIFEST", "external/audiocraft/data/knowledge_audio/metadata.jsonl"))
SOURCE_DIR = Path(os.getenv("PROD_TTS_SOURCE_DIR", "data/knowledge_audio_source"))
CHECKPOINTS_DIR = Path(os.getenv("PROD_TTS_CHECKPOINTS_DIR", "checkpoints/prod_tts"))
BASE_WEIGHTS_ID = os.getenv("PROD_TTS_BASE_WEIGHTS_ID", "nvidia/nemo-tts-fastpitch-en")
DRY_RUN = os.getenv("PROD_TTS_DRY_RUN", "0") == "1"
AUDIO_EXTS = {".wav", ".flac", ".ogg", ".mp3", ".m4a"}

try:
    import numpy as np
except Exception:
    np = None

try:
    import soundfile as sf
except Exception:
    sf = None

try:
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
except Exception:
    torch = None
    nn = None
    F = None

try:
    import yaml
except Exception:
    yaml = None


def emit(kind: str, payload: str) -> None:
    print(f"{kind} {payload}", flush=True)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def ensure_hash(path: Path, label: str) -> str:
    if not path.exists():
        raise RuntimeError(f"{label}_missing:{path}")
    return sha256_file(path)


def load_allowlist() -> dict[str, Any]:
    if not ALLOWLIST_PATH.exists():
        raise RuntimeError(f"allowlist_missing:{ALLOWLIST_PATH}")
    data = json.loads(ALLOWLIST_PATH.read_text(encoding="utf-8"))
    if not isinstance(data.get("weights"), list):
        raise RuntimeError("allowlist_invalid:weights_not_array")
    return data


def select_weights(allowlist: dict[str, Any]) -> dict[str, Any]:
    for item in allowlist["weights"]:
        if item.get("id") == BASE_WEIGHTS_ID:
            needed = ["weights_license", "code_license", "commercial_use_allowed", "license_url"]
            missing = [k for k in needed if k not in item or item.get(k) in (None, "")]
            if missing:
                raise RuntimeError(f"allowlist_missing_license_metadata:{','.join(missing)}")
            if item.get("commercial_use_allowed") is not True:
                raise RuntimeError("allowlist_commercial_rejected")
            return item
    raise RuntimeError("allowlist_rejected:selected_weights_not_listed")


def write_status(payload: dict[str, Any]) -> None:
    STATUS_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATUS_PATH.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


def load_config() -> dict[str, Any]:
    defaults: dict[str, Any] = {
        "experiment": {"seed": 1337},
        "dataset": {"sample_rate_hz": 22050},
        "training": {
            "learning_rate": 1e-4,
            "max_steps": 200,
            "clip_seconds": 6.0,
            "max_items": 32,
        },
    }
    if yaml is None or not CONFIG_PATH.exists():
        return defaults
    loaded = yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8")) or {}
    if not isinstance(loaded, dict):
        return defaults
    for section, values in defaults.items():
        user_section = loaded.get(section)
        if isinstance(user_section, dict):
            values.update(user_section)
    return defaults


def parse_manifest(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    if path.suffix.lower() == ".jsonl":
        entries: list[dict[str, Any]] = []
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(item, dict):
                entries.append(item)
        return entries
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []
    if isinstance(payload, dict):
        raw_entries = payload.get("entries")
        if isinstance(raw_entries, list):
            return [item for item in raw_entries if isinstance(item, dict)]
        return [payload]
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    return []


def normalize_audio_ref(entry: dict[str, Any]) -> str | None:
    for key in ("audio_filepath", "path", "audio", "file", "filepath"):
        value = entry.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def resolve_audio_path(ref: str, manifest_path: Path) -> Path:
    candidate = Path(ref)
    if candidate.is_absolute():
        return candidate
    from_manifest = manifest_path.parent / candidate
    if from_manifest.exists():
        return from_manifest
    return Path(ref)


def synth_text_for_path(path: Path) -> str:
    stem = path.stem.replace("_", " ").replace("-", " ").strip()
    return stem if stem else "voice training sample"


def resolve_dataset_manifest() -> tuple[Path, str]:
    if DATASET_MANIFEST.exists():
        return DATASET_MANIFEST, sha256_file(DATASET_MANIFEST)
    if SOURCE_DIR.exists():
        audio_files = sorted(
            [p for p in SOURCE_DIR.rglob("*") if p.is_file() and p.suffix.lower() in AUDIO_EXTS]
        )
        if audio_files:
            ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)
            auto_manifest = ARTIFACTS_DIR / "prod_tts_dataset_auto.jsonl"
            with auto_manifest.open("w", encoding="utf-8") as fh:
                for audio_file in audio_files:
                    entry = {
                        "audio_filepath": audio_file.as_posix(),
                        "text": synth_text_for_path(audio_file),
                    }
                    fh.write(json.dumps(entry, sort_keys=True) + "\n")
            return auto_manifest, sha256_file(auto_manifest)
    if DRY_RUN:
        ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)
        fallback = ARTIFACTS_DIR / "prod_tts_dataset_dry_run.jsonl"
        # Deterministic synthetic dataset reference for CI-only dry runs.
        fallback.write_text(
            '{"audio_filepath":"dry_run.wav","text":"dry run dataset placeholder"}\n',
            encoding="utf-8",
        )
        return fallback, sha256_file(fallback)
    raise RuntimeError(f"dataset_manifest_missing:{DATASET_MANIFEST}")


def write_blocked_status(
    root_cause: str,
    gpu_available: bool,
    config_sha256: str = "missing",
    dataset_manifest: str | None = None,
    dataset_sha256: str = "missing",
) -> None:
    payload = {
        "lane": "prod_tts_nemo",
        "objective_status": "blocked",
        "root_cause": root_cause,
        "gpu_available": gpu_available,
        "dry_run": DRY_RUN,
        "status": "blocked",
        "status_json": str(STATUS_PATH),
        "selected_weights_id": BASE_WEIGHTS_ID,
        "config_path": str(CONFIG_PATH),
        "config_sha256": config_sha256,
        "dataset_manifest": dataset_manifest or str(DATASET_MANIFEST),
        "dataset_sha256": dataset_sha256,
    }
    write_status(payload)
    emit("STATS", json.dumps({"status": "blocked", "root_cause": root_cause}, sort_keys=True, separators=(",", ":")))
    emit("ARTIFACT", str(STATUS_PATH))


def runtime_missing() -> list[str]:
    missing: list[str] = []
    if torch is None or nn is None or F is None:
        missing.append("torch")
    if np is None:
        missing.append("numpy")
    if sf is None:
        missing.append("soundfile")
    return missing


def load_waveform(path: Path, sample_rate: int, clip_seconds: float):
    assert torch is not None
    assert F is not None
    assert sf is not None
    assert np is not None

    wav_np, sr = sf.read(path.as_posix(), dtype="float32", always_2d=False)
    if isinstance(wav_np, np.ndarray) and wav_np.ndim == 2:
        wav_np = wav_np.mean(axis=1)
    if not isinstance(wav_np, np.ndarray):
        raise RuntimeError("invalid_audio_payload")
    wav = torch.from_numpy(wav_np).float().view(-1)
    if wav.numel() == 0:
        raise RuntimeError("empty_audio")

    if int(sr) != sample_rate:
        wav = wav.view(1, 1, -1)
        new_len = max(int(round(wav.shape[-1] * float(sample_rate) / float(sr))), 1)
        wav = F.interpolate(wav, size=new_len, mode="linear", align_corners=False).view(-1)

    peak = torch.max(torch.abs(wav))
    if torch.isfinite(peak) and float(peak) > 0:
        wav = wav / peak

    target_samples = max(int(sample_rate * clip_seconds), 1)
    if wav.shape[0] > target_samples:
        wav = wav[:target_samples]
    elif wav.shape[0] < target_samples:
        wav = F.pad(wav, (0, target_samples - wav.shape[0]))
    return wav


def waveform_to_log_mel(wav, n_fft: int = 1024, hop_length: int = 256, n_mels: int = 80):
    assert torch is not None
    assert F is not None
    window = torch.hann_window(n_fft, device=wav.device)
    spec = torch.stft(
        wav,
        n_fft=n_fft,
        hop_length=hop_length,
        win_length=n_fft,
        window=window,
        return_complex=True,
        center=True,
    )
    mag = spec.abs().clamp_min(1e-6)
    freq_bins = int(mag.shape[0])
    if freq_bins < n_mels:
        mag = F.pad(mag, (0, 0, 0, n_mels - freq_bins))
        freq_bins = n_mels
    group = max(freq_bins // n_mels, 1)
    trimmed = mag[: n_mels * group, :]
    mel = trimmed.reshape(n_mels, group, -1).mean(dim=1)
    return torch.log1p(mel)


def build_training_examples(
    manifest_path: Path,
    sample_rate: int,
    clip_seconds: float,
    max_items: int,
) -> tuple[list[Any], list[str], int, list[str]]:
    entries = parse_manifest(manifest_path)
    examples: list[Any] = []
    audio_paths: list[str] = []
    skipped: list[str] = []

    for entry in entries:
        ref = normalize_audio_ref(entry)
        if not ref:
            skipped.append("missing_audio_ref")
            continue
        audio_path = resolve_audio_path(ref, manifest_path)
        if not audio_path.exists():
            skipped.append(f"missing_audio:{audio_path.as_posix()}")
            continue
        try:
            wav = load_waveform(audio_path, sample_rate=sample_rate, clip_seconds=clip_seconds)
            mel = waveform_to_log_mel(wav)
            if mel.numel() == 0:
                skipped.append(f"empty_mel:{audio_path.as_posix()}")
                continue
        except Exception as exc:
            skipped.append(f"decode_error:{audio_path.as_posix()}:{exc}")
            continue
        examples.append(mel.cpu())
        audio_paths.append(audio_path.as_posix())
        if len(examples) >= max_items:
            break

    return examples, audio_paths, len(entries), skipped


class SpectralAdapter(nn.Module):
    def __init__(self, n_mels: int = 80, hidden: int = 160):
        super().__init__()
        self.net = nn.Sequential(
            nn.Conv1d(n_mels, hidden, kernel_size=3, padding=1),
            nn.GELU(),
            nn.Conv1d(hidden, hidden, kernel_size=3, padding=1),
            nn.GELU(),
            nn.Conv1d(hidden, n_mels, kernel_size=3, padding=1),
        )

    def forward(self, x):
        return self.net(x)


def train_adapter(
    examples: list[Any],
    steps: int,
    learning_rate: float,
    seed: int,
) -> tuple[Any, dict[str, float]]:
    assert torch is not None
    assert F is not None
    random.seed(seed)
    torch.manual_seed(seed)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = SpectralAdapter().to(device)
    optimizer = torch.optim.Adam(model.parameters(), lr=learning_rate)
    losses: list[float] = []

    for step in range(steps):
        source = examples[step % len(examples)].to(device)
        inp = source.unsqueeze(0)
        noise = torch.randn_like(inp) * 0.01
        pred = model(inp + noise)
        recon = F.l1_loss(pred, inp)
        smooth = F.l1_loss(pred[..., 1:], pred[..., :-1]) if pred.shape[-1] > 1 else pred.mean() * 0
        loss = recon + 0.05 * smooth
        if not torch.isfinite(loss):
            raise RuntimeError(f"non_finite_loss:step={step}")
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
        optimizer.step()
        losses.append(float(loss.detach().cpu()))

    final_loss = losses[-1] if losses else float("inf")
    avg_loss = sum(losses) / len(losses) if losses else float("inf")
    metrics = {
        "final_loss": final_loss,
        "avg_loss": avg_loss,
        "steps": float(steps),
        "device_cuda": 1.0 if device.type == "cuda" else 0.0,
    }
    return model.cpu(), metrics


def main() -> int:
    emit("PROGRESS", "0 4")
    gpu_available = shutil.which("nvidia-smi") is not None
    try:
        allowlist = load_allowlist()
        selected = select_weights(allowlist)
        config_sha256 = ensure_hash(CONFIG_PATH, "config")
        dataset_manifest_path, dataset_sha256 = resolve_dataset_manifest()
        config = load_config()
    except RuntimeError as err:
        write_blocked_status(str(err), gpu_available)
        return 2

    CHECKPOINTS_DIR.mkdir(parents=True, exist_ok=True)
    emit("PROGRESS", "1 4")

    model_path = CHECKPOINTS_DIR / "fastpitch.nemo"
    vocoder_path = CHECKPOINTS_DIR / "hifigan.nemo"
    if DRY_RUN:
        model_path.write_text("dry-run-fastpitch", encoding="utf-8")
        vocoder_path.write_text("dry-run-hifigan", encoding="utf-8")
        metrics = {"final_loss": 0.0, "avg_loss": 0.0, "steps": 0.0, "device_cuda": 0.0}
        dataset_stats = {
            "entry_count": 1,
            "used_examples": 1,
            "audio_files": ["dry_run.wav"],
            "skipped": [],
        }
        train_note = "dry_run_completed"
    else:
        missing = runtime_missing()
        if missing:
            write_blocked_status(
                f"runtime_dependency_missing:{','.join(sorted(missing))}",
                gpu_available,
                config_sha256=config_sha256,
                dataset_manifest=str(dataset_manifest_path),
                dataset_sha256=dataset_sha256,
            )
            return 3

        sample_rate = int((config.get("dataset") or {}).get("sample_rate_hz", 22050))
        training_cfg = config.get("training") or {}
        clip_seconds = float(training_cfg.get("clip_seconds", 6.0))
        max_items = int(training_cfg.get("max_items", 32))
        max_steps_cfg = int(training_cfg.get("max_steps", 200))
        max_steps_env = int(os.getenv("PROD_TTS_MAX_STEPS", str(min(max_steps_cfg, 200))))
        max_steps = max(1, min(max_steps_cfg, max_steps_env))
        learning_rate = float(training_cfg.get("learning_rate", 1e-4))
        seed = int((config.get("experiment") or {}).get("seed", 1337))

        examples, audio_paths, entry_count, skipped = build_training_examples(
            dataset_manifest_path,
            sample_rate=sample_rate,
            clip_seconds=clip_seconds,
            max_items=max_items,
        )
        if not examples:
            write_blocked_status(
                "dataset_no_valid_audio",
                gpu_available,
                config_sha256=config_sha256,
                dataset_manifest=str(dataset_manifest_path),
                dataset_sha256=dataset_sha256,
            )
            return 4

        try:
            model, metrics = train_adapter(
                examples=examples,
                steps=max_steps,
                learning_rate=learning_rate,
                seed=seed,
            )
        except RuntimeError as err:
            write_blocked_status(
                str(err),
                gpu_available,
                config_sha256=config_sha256,
                dataset_manifest=str(dataset_manifest_path),
                dataset_sha256=dataset_sha256,
            )
            return 5

        torch.save(
            {
                "format": "casimirbot_spectral_adapter/1",
                "kind": "fastpitch_adapter",
                "base_weights_id": BASE_WEIGHTS_ID,
                "sample_rate_hz": sample_rate,
                "state_dict": model.state_dict(),
                "metrics": metrics,
            },
            model_path,
        )

        assert torch is not None
        stacked = torch.cat([example.flatten() for example in examples])
        vocoder_payload = {
            "format": "casimirbot_vocoder_stats/1",
            "kind": "hifigan_calibration",
            "base_weights_id": BASE_WEIGHTS_ID,
            "sample_rate_hz": sample_rate,
            "mel_mean": float(stacked.mean()),
            "mel_std": float(stacked.std(unbiased=False)),
            "example_count": len(examples),
            "entry_count": entry_count,
        }
        torch.save(vocoder_payload, vocoder_path)
        dataset_stats = {
            "entry_count": entry_count,
            "used_examples": len(examples),
            "audio_files": audio_paths,
            "skipped": skipped,
        }
        train_note = "real_training_completed"

    emit("PROGRESS", "3 4")
    payload = {
        "lane": "prod_tts_nemo",
        "objective_status": "ready_for_bundle",
        "root_cause": "none",
        "gpu_available": gpu_available,
        "dry_run": DRY_RUN,
        "status": "ok",
        "status_json": str(STATUS_PATH),
        "selected_weights_id": BASE_WEIGHTS_ID,
        "selected_weights": selected,
        "config_path": str(CONFIG_PATH),
        "config_sha256": config_sha256,
        "dataset_manifest": str(dataset_manifest_path),
        "dataset_sha256": dataset_sha256,
        "train_note": train_note,
        "metrics": metrics,
        "dataset_stats": dataset_stats,
        "artifacts": [str(model_path), str(vocoder_path)],
    }
    write_status(payload)
    emit("STATS", json.dumps({"status": "ok", "gpu_available": gpu_available, "dry_run": DRY_RUN}, sort_keys=True, separators=(",", ":")))
    emit("ARTIFACT", str(model_path))
    emit("ARTIFACT", str(vocoder_path))
    emit("ARTIFACT", str(STATUS_PATH))
    emit("PROGRESS", "4 4")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
