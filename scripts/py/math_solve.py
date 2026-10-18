#!/usr/bin/env python3
"""
SymPy-backed math solver for Helix Ask.
Reads JSON from stdin and writes JSON to stdout.
"""

import json
import re
import sys

try:
    from sympy import Eq, Symbol, diff, simplify, solve, sin, cos, tan, sqrt, log, exp, pi, E
    from sympy.parsing.sympy_parser import (
        parse_expr,
        standard_transformations,
        implicit_multiplication_application,
        convert_xor,
    )
except Exception as exc:  # pragma: no cover - import guard
    sys.stdout.write(json.dumps({"ok": False, "reason": f"sympy_import_error:{type(exc).__name__}"}))
    sys.exit(0)


TRANSFORMS = standard_transformations + (implicit_multiplication_application, convert_xor)

X = Symbol("x")

SAFE_LOCALS = {
    "x": X,
    "sin": sin,
    "cos": cos,
    "tan": tan,
    "sqrt": sqrt,
    "log": log,
    "exp": exp,
    "pi": pi,
    "e": E,
}


def sanitize_expr(text: str) -> str:
    cleaned = text.strip()
    cleaned = cleaned.replace("\u2212", "-").replace("\u2013", "-").replace("\u2014", "-")
    cleaned = cleaned.replace("\u00d7", "*").replace("\u00f7", "/").replace("\u2217", "*")
    cleaned = cleaned.replace(",", " ")
    cleaned = re.split(r"\.(?=\s*[A-Za-z])", cleaned, maxsplit=1)[0]
    cleaned = re.sub(r"[?;:]+$", "", cleaned).strip()
    return cleaned


def extract_equation(text: str) -> str:
    match = re.search(r"solve(?: for x)?\s*[:]?(.+)", text, re.IGNORECASE)
    if match:
        return sanitize_expr(match.group(1))
    if "=" in text:
        return sanitize_expr(text)
    return ""


def extract_derivative_expr(text: str) -> str:
    match = re.search(r"f\(x\)\s*=\s*(.+)", text, re.IGNORECASE)
    if match:
        return sanitize_expr(match.group(1))
    match = re.search(r"derivative of\s+(.+)", text, re.IGNORECASE)
    if match:
        return sanitize_expr(match.group(1))
    match = re.search(r"d/dx\s*(.+)", text, re.IGNORECASE)
    if match:
        return sanitize_expr(match.group(1))
    return ""


def solve_equation(expr: str):
    if "=" in expr:
        left, right = expr.split("=", 1)
        left_expr = parse_expr(left, transformations=TRANSFORMS, local_dict=SAFE_LOCALS)
        right_expr = parse_expr(right, transformations=TRANSFORMS, local_dict=SAFE_LOCALS)
        equation = Eq(left_expr, right_expr)
    else:
        left_expr = parse_expr(expr, transformations=TRANSFORMS, local_dict=SAFE_LOCALS)
        equation = Eq(left_expr, 0)
    sols = list(dict.fromkeys(solve(equation, X)))
    return equation, sols


def main() -> None:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        sys.stdout.write(json.dumps({"ok": False, "reason": "bad_payload"}))
        return

    question = str(payload.get("question", "")).strip()
    if not question:
        sys.stdout.write(json.dumps({"ok": False, "reason": "missing_question"}))
        return

    lowered = question.lower()
    try:
        if "derivative" in lowered or "d/dx" in lowered:
            expr = extract_derivative_expr(question)
            if not expr:
                sys.stdout.write(json.dumps({"ok": False, "reason": "missing_expression"}))
                return
            parsed = parse_expr(expr, transformations=TRANSFORMS, local_dict=SAFE_LOCALS)
            deriv = simplify(diff(parsed, X))
            sys.stdout.write(
                json.dumps(
                    {
                        "ok": True,
                        "kind": "derivative",
                        "expr": expr,
                        "final": str(deriv),
                    }
                )
            )
            return

        if "solve" in lowered or "=" in question:
            equation_str = extract_equation(question)
            if not equation_str:
                sys.stdout.write(json.dumps({"ok": False, "reason": "missing_equation"}))
                return
            equation, sols = solve_equation(equation_str)
            if not sols:
                sys.stdout.write(json.dumps({"ok": False, "reason": "no_solution"}))
                return
            sys.stdout.write(
                json.dumps(
                    {
                        "ok": True,
                        "kind": "solve",
                        "equation": str(equation),
                        "solutions": [str(sol) for sol in sols],
                        "final": ", ".join([str(sol) for sol in sols]),
                    }
                )
            )
            return

        expr = sanitize_expr(question)
        parsed = parse_expr(expr, transformations=TRANSFORMS, local_dict=SAFE_LOCALS)
        value = simplify(parsed)
        sys.stdout.write(
            json.dumps(
                {
                    "ok": True,
                    "kind": "evaluate",
                    "expr": expr,
                    "final": str(value),
                }
            )
        )
    except Exception as exc:
        sys.stdout.write(json.dumps({"ok": False, "reason": f"sympy_exception:{type(exc).__name__}"}))


if __name__ == "__main__":
    main()
