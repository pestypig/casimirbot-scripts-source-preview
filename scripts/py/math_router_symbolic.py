#!/usr/bin/env python3
import json
import sys
from sympy import Matrix, Symbol, E, diff, simplify
from sympy.parsing.sympy_parser import parse_expr, standard_transformations, implicit_multiplication_application, convert_xor

TRANSFORMS = standard_transformations + (implicit_multiplication_application, convert_xor)

def parse_matrix(payload):
    rows = payload.get("matrix")
    if not isinstance(rows, list):
        raise ValueError("matrix_required")
    return Matrix(rows)

def main():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except Exception:
        print(json.dumps({"ok": False, "reason": "bad_payload"}))
        return

    op = payload.get("op")
    constants = payload.get("constants") or {}
    e_mode = constants.get("e", "euler")
    e_symbol = Symbol("e") if e_mode == "symbol" else E
    locals_dict = {"e": e_symbol}

    try:
        if op in ("determinant", "inverse", "trace", "eigenvalues"):
            m = parse_matrix(payload)
            if op == "determinant":
                value = simplify(m.det())
            elif op == "inverse":
                value = m.inv()
            elif op == "trace":
                value = simplify(m.trace())
            else:
                value = [simplify(v) for v in m.eigenvals().keys()]
            print(json.dumps({"ok": True, "op": op, "result": str(value)}))
            return

        if op == "derivative":
            expr = str(payload.get("expr", "")).strip()
            variable = str(payload.get("variable", "x")).strip() or "x"
            parsed = parse_expr(expr, transformations=TRANSFORMS, local_dict=locals_dict)
            var = Symbol(variable)
            value = simplify(diff(parsed, var))
            print(json.dumps({"ok": True, "op": op, "result": str(value)}))
            return

        print(json.dumps({"ok": False, "reason": "unsupported_op"}))
    except Exception as exc:
        print(json.dumps({"ok": False, "reason": f"symbolic_error:{type(exc).__name__}"}))

if __name__ == "__main__":
    main()
