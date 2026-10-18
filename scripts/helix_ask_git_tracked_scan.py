#!/usr/bin/env python3
"""Scan git-tracked files for query terms and return JSON hits."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from typing import Dict, Iterable, List, Optional


SKIP_SUFFIXES = (
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".ico",
    ".svg",
    ".pdf",
    ".zip",
    ".tar",
    ".gz",
    ".tgz",
    ".7z",
    ".exe",
    ".dll",
    ".so",
    ".dylib",
    ".ttf",
    ".otf",
    ".woff",
    ".woff2",
    ".mp3",
    ".mp4",
    ".mov",
    ".avi",
    ".wav",
    ".glb",
    ".bin",
    ".pyc",
    ".map",
)


def normalize_line(value: str, max_chars: int) -> str:
    compact = " ".join(value.replace("\r", " ").replace("\n", " ").split()).strip()
    if len(compact) <= max_chars:
        return compact
    return compact[: max_chars - 3] + "..."


def compile_patterns(entries: Iterable[str]) -> List[re.Pattern]:
    compiled: List[re.Pattern] = []
    for raw in entries:
        text = (raw or "").strip()
        if not text:
            continue
        try:
            compiled.append(re.compile(text, re.IGNORECASE))
        except re.error:
            continue
    return compiled


def path_allowed(path_value: str, allowlist: List[re.Pattern], avoidlist: List[re.Pattern]) -> bool:
    normalized = path_value.replace("\\", "/")
    for pattern in avoidlist:
        if pattern.search(normalized):
            return False
    if not allowlist:
        return True
    return any(pattern.search(normalized) for pattern in allowlist)


def is_scan_candidate(path_value: str, max_file_bytes: int) -> bool:
    lower = path_value.lower()
    if lower.endswith(SKIP_SUFFIXES):
        return False
    try:
        size = os.path.getsize(path_value)
    except OSError:
        return False
    return size <= max_file_bytes


def list_git_files() -> List[str]:
    proc = subprocess.run(
        ["git", "ls-files", "--recurse-submodules"],
        check=False,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or "git ls-files failed").strip())
    files = []
    for entry in proc.stdout.splitlines():
        path_value = entry.strip()
        if not path_value:
            continue
        files.append(path_value.replace("\\", "/"))
    return files


def scan_file(file_path: str, lowered_terms: List[str], max_line_chars: int) -> List[Dict[str, object]]:
    hits: List[Dict[str, object]] = []
    try:
        with open(file_path, "r", encoding="utf-8", errors="ignore") as handle:
            for line_number, raw_line in enumerate(handle, start=1):
                lower_line = raw_line.lower()
                for term in lowered_terms:
                    if term in lower_line:
                        hits.append(
                            {
                                "filePath": file_path.replace("\\", "/"),
                                "line": line_number,
                                "text": normalize_line(raw_line, max_line_chars),
                                "term": term,
                            }
                        )
    except OSError:
        return []
    return hits


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Helix Ask git-tracked retrieval scan")
    parser.add_argument("--term", action="append", default=[], help="Search term (repeatable)")
    parser.add_argument("--file", action="append", default=[], help="Optional explicit file list (repeatable)")
    parser.add_argument("--allow", action="append", default=[], help="Allowlist regex (repeatable)")
    parser.add_argument("--avoid", action="append", default=[], help="Avoidlist regex (repeatable)")
    parser.add_argument("--max-hits", type=int, default=24, help="Global max hits")
    parser.add_argument("--max-per-term", type=int, default=6, help="Max hits per term")
    parser.add_argument("--max-file-bytes", type=int, default=786432, help="Skip files larger than this")
    parser.add_argument("--max-line-chars", type=int, default=180, help="Clip text line length")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    raw_terms = [term.strip().lower() for term in args.term if term and term.strip()]
    dedup_terms = list(dict.fromkeys(raw_terms))
    if not dedup_terms:
        print(json.dumps({"hits": [], "truncated": False, "error": "missing_terms"}))
        return 0

    allowlist = compile_patterns(args.allow)
    avoidlist = compile_patterns(args.avoid)
    max_hits = max(1, int(args.max_hits))
    max_per_term = max(1, int(args.max_per_term))
    max_file_bytes = max(1024, int(args.max_file_bytes))
    max_line_chars = max(60, int(args.max_line_chars))

    if args.file:
        tracked_files = []
        seen_files = set()
        for raw in args.file:
            normalized = (raw or "").strip().replace("\\", "/")
            if not normalized or normalized in seen_files:
                continue
            seen_files.add(normalized)
            tracked_files.append(normalized)
    else:
        try:
            tracked_files = list_git_files()
        except Exception as exc:  # pragma: no cover - defensive path
            print(json.dumps({"hits": [], "truncated": False, "error": f"git_ls_files_failed:{exc}"}))
            return 0

    per_term_counts: Dict[str, int] = {term: 0 for term in dedup_terms}
    hits: List[Dict[str, object]] = []
    truncated = False

    for relative_path in tracked_files:
        if len(hits) >= max_hits:
            truncated = True
            break
        if not path_allowed(relative_path, allowlist, avoidlist):
            continue
        if not is_scan_candidate(relative_path, max_file_bytes):
            continue
        file_hits = scan_file(relative_path, dedup_terms, max_line_chars)
        if not file_hits:
            continue
        for hit in file_hits:
            term = str(hit.get("term", ""))
            if not term:
                continue
            if per_term_counts.get(term, 0) >= max_per_term:
                continue
            hits.append(hit)
            per_term_counts[term] = per_term_counts.get(term, 0) + 1
            if len(hits) >= max_hits:
                truncated = True
                break

    print(json.dumps({"hits": hits, "truncated": truncated}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
