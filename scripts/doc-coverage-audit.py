#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path


def main() -> None:
    repo = Path(__file__).resolve().parents[1]
    surfaces = [
        "client",
        "server",
        "shared",
        "scripts",
        "modules",
        "tools",
        "sdk",
        "packages",
        "cli",
        "tests",
        "datasets",
        "templates",
        "reports",
        "public",
    ]
    scope_extensions = [
        ".ts",
        ".tsx",
        ".js",
        ".jsx",
        ".py",
        ".json",
        ".jsonl",
        ".sql",
        ".sh",
        ".ps1",
        ".yaml",
        ".yml",
    ]
    code_exts = set(scope_extensions)

    code_files_by_surface: dict[str, list[str]] = {s: [] for s in surfaces}
    for surface in surfaces:
        root = repo / surface
        if not root.exists():
            continue
        for path in root.rglob("*"):
            if path.is_dir():
                continue
            if "node_modules" in path.parts or ".git" in path.parts:
                continue
            if path.suffix.lower() not in code_exts:
                continue
            code_files_by_surface[surface].append(path.relative_to(repo).as_posix())

    md_files: list[Path] = []
    for path in repo.rglob("*.md"):
        rel = path.relative_to(repo)
        if rel.parts and rel.parts[0] == "external":
            continue
        if "node_modules" in rel.parts or ".git" in rel.parts:
            continue
        md_files.append(rel)

    pattern = re.compile(
        r"\b("
        + "|".join(re.escape(surface) for surface in surfaces)
        + r")(?:/|\\)[^\s\)\]\}\"'>,]+"
    )

    ref_paths_by_surface: dict[str, set[str]] = defaultdict(set)
    for rel in md_files:
        text = (repo / rel).read_text(encoding="utf-8", errors="ignore")
        for match in pattern.finditer(text):
            ref = match.group(0).rstrip(").,:;`\"']")
            ref = ref.replace("\\", "/")
            if not any(ref.startswith(surface + "/") for surface in surfaces):
                # Trim leading prefixes without clipping mid-path surface names.
                for surface in surfaces:
                    marker = surface + "/"
                    idx = ref.find(marker)
                    if idx > 0:
                        ref = ref[idx:]
                        break
            ref_paths_by_surface[match.group(1)].add(ref)

    resolved_refs_by_surface: dict[str, set[str]] = defaultdict(set)
    for surface, refs in ref_paths_by_surface.items():
        for ref in refs:
            ref_path = repo / ref
            if ref_path.is_file() and ref_path.suffix.lower() in code_exts:
                resolved_refs_by_surface[surface].add(ref)

    coverage: dict[str, dict[str, object]] = {}
    for surface in surfaces:
        total_files = sorted(set(code_files_by_surface.get(surface, [])))
        referenced_files = sorted(set(resolved_refs_by_surface.get(surface, set())))
        missing_files = [path for path in total_files if path not in referenced_files]
        coverage[surface] = {
            "total_files": len(total_files),
            "referenced_files": len(referenced_files),
            "missing_files": missing_files,
            "coverage_ratio": (
                len(referenced_files) / len(total_files) if total_files else 0.0
            ),
        }

    artifacts_root = os.environ.get("AGI_ARTIFACTS_DIR")
    if artifacts_root:
        artifacts_dir = Path(artifacts_root)
        if not artifacts_dir.is_absolute():
            artifacts_dir = (repo / artifacts_dir).resolve()
    else:
        artifacts_dir = repo / "artifacts"
    out_path = artifacts_dir / "doc-coverage-gaps.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    report = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "scopeExtensions": scope_extensions,
        "surfaces": coverage,
        "notes": [
            "Coverage is computed only for files with extensions in scopeExtensions.",
            "Doc references to other asset types are ignored in referenced_files counts.",
        ],
    }
    out_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({"outPath": str(out_path), "surfaces": len(surfaces)}, indent=2))


if __name__ == "__main__":
    main()
