#!/usr/bin/env python3
from __future__ import annotations

import json
import importlib.util
import os
import subprocess
import sys
from pathlib import Path


def load_export_bundle():
    script_dir = Path(__file__).resolve().parent
    module_path = script_dir / 'export_voice_bundle.py'
    spec = importlib.util.spec_from_file_location('export_voice_bundle', module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f'failed to load export module at {module_path.as_posix()}')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if not hasattr(module, 'export_bundle'):
        raise RuntimeError('export_voice_bundle.py missing export_bundle')
    return module.export_bundle


export_bundle = load_export_bundle()


def emit(line: str) -> None:
    print(line, flush=True)


def main() -> int:
    root = Path(os.getenv('REPO_ROOT', Path(__file__).resolve().parents[2]))
    artifacts = root / 'artifacts'
    checkpoints = root / 'checkpoints'
    bundles = root / 'bundles'
    artifacts.mkdir(exist_ok=True)
    checkpoints.mkdir(exist_ok=True)
    bundles.mkdir(exist_ok=True)

    profile_id = os.getenv('VOICE_PROFILE_ID', 'dottie_default')
    model_path = checkpoints / 'tts_prod_train_model.bin'
    sample_path = artifacts / 'tts_prod_train_sample.wav'
    raw_status_path = os.getenv('TRAIN_STATUS_PATH')
    if raw_status_path:
        status_path = Path(raw_status_path)
        if not status_path.is_absolute():
            status_path = root / status_path
    else:
        status_path = artifacts / 'train_status.tts_prod_train.json'
    status_path.parent.mkdir(parents=True, exist_ok=True)
    dataset_manifest_path = artifacts / 'dataset_manifest.tts_prod_train.json'

    emit('PROGRESS 0 100')
    dataset_manifest = {'mode': 'voice_dataset', 'entries': [{'path': 'data/knowledge_audio_source/auntie_dottie.flac'}]}
    dataset_manifest_path.write_text(json.dumps(dataset_manifest, indent=2), encoding='utf-8')
    emit(f'STATS {json.dumps({"dataset_items": 1, "manifest_path": dataset_manifest_path.as_posix()}, separators=(",", ":"))}')

    model_path.write_bytes(b'tts-prod-model-v1')
    sample_path.write_bytes(b'RIFF....WAVEfmt')

    bundle_dir = bundles / profile_id / 'voice_bundle'
    manifest_path = export_bundle(profile_id, 'Dottie', model_path, sample_path, bundle_dir)
    emit(f'ARTIFACT {manifest_path.as_posix()}')
    emit('PROGRESS 90 100')

    cmd = [
        'node',
        '--input-type=module',
        '-e',
        (
            "import { validateVoiceBundle } from './server/services/voice-bundle/validator.ts';"
            f"const r=validateVoiceBundle('{bundle_dir.as_posix()}');"
            "if(!r.ok){console.error(JSON.stringify(r));process.exit(2);}"
            "console.log(JSON.stringify(r));"
        ),
    ]
    proc = subprocess.run(cmd, cwd=root, capture_output=True, text=True)
    if proc.returncode != 0:
        status = {
            'job_type': 'tts_prod_train',
            'status': 'error',
            'state': 'error',
            'error': 'voice_bundle_validation_failed',
            'details': proc.stderr.strip() or proc.stdout.strip(),
        }
        status_path.write_text(json.dumps(status, indent=2), encoding='utf-8')
        emit(f'STATS {json.dumps({"bundle_valid": False}, separators=(",", ":"))}')
        return 2

    emit(f'STATS {json.dumps({"bundle_valid": True, "profile_id": profile_id}, separators=(",", ":"))}')
    emit('PROGRESS 100 100')
    status = {
        'job_type': 'tts_prod_train',
        'status': 'completed',
        'state': 'completed',
        'progress': {'current': 100, 'total': 100},
        'stats': {'dataset_items': 1, 'bundle_valid': True},
        'artifacts': [manifest_path.as_posix(), dataset_manifest_path.as_posix()],
    }
    status_path.write_text(json.dumps(status, indent=2), encoding='utf-8')
    emit(f'ARTIFACT {status_path.as_posix()}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
