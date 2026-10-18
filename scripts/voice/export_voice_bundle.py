#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(65536), b''):
            h.update(chunk)
    return h.hexdigest()


def export_bundle(profile_id: str, display_name: str, model_path: Path, sample_path: Path, out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    model_target = out_dir / 'model.bin'
    sample_target = out_dir / 'sample.wav'
    model_target.write_bytes(model_path.read_bytes())
    sample_target.write_bytes(sample_path.read_bytes())
    manifest = {
        'bundle_version': 'voice_bundle/1',
        'voice_profile_id': profile_id,
        'display_name': display_name,
        'created_at': datetime.now(timezone.utc).isoformat(),
        'files': [
            {'path': 'model.bin', 'sha256': sha256(model_target), 'bytes': model_target.stat().st_size},
            {'path': 'sample.wav', 'sha256': sha256(sample_target), 'bytes': sample_target.stat().st_size},
        ],
    }
    manifest_path = out_dir / 'manifest.json'
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    return manifest_path


if __name__ == '__main__':
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument('--profile-id', required=True)
    parser.add_argument('--display-name', default='Dottie')
    parser.add_argument('--model-path', required=True)
    parser.add_argument('--sample-path', required=True)
    parser.add_argument('--out-dir', required=True)
    args = parser.parse_args()

    manifest_path = export_bundle(
        args.profile_id,
        args.display_name,
        Path(args.model_path),
        Path(args.sample_path),
        Path(args.out_dir),
    )
    print(f'ARTIFACT {manifest_path.as_posix()}')
