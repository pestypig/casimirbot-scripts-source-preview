#!/usr/bin/env python3
"""
Line-oriented SymPy checker used by math.sympy.verify.
Reads JSON from stdin and writes JSON to stdout.
"""

import json
import sys

try:
    from sympy import sympify, simplify
    from sympy.parsing.sympy_parser import parse_expr
except Exception as exc:  # pragma: no cover - import guard
    sys.stdout.write(json.dumps({"ok": False, "reason": f"sympy_import_error:{type(exc).__name__}"}))
    sys.exit(0)


def is_correct(final_str: str, truth_str: str) -> bool:
    try:
        fa = sympify(final_str)
        gt = sympify(truth_str)
        if fa.is_number and gt.is_number:
            return simplify(fa - gt) == 0
        return simplify(parse_expr(final_str) - parse_expr(truth_str)) == 0
    except Exception:
        return False


def main() -> None:
    try:
        data = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        sys.stdout.write(json.dumps({"ok": False, "reason": "bad_payload"}))
        return

    final = str(data.get("final_answer", "")).strip()
    truth = str(data.get("ground_truth", "")).strip()
    if not final or not truth:
        sys.stdout.write(json.dumps({"ok": False, "reason": "missing_inputs"}))
        return

    ok = is_correct(final, truth)
    sys.stdout.write(json.dumps({"ok": bool(ok), "reason": "pass" if ok else "mismatch"}))


if __name__ == "__main__":
    main()
