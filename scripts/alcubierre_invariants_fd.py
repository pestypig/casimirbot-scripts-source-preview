#!/usr/bin/env python3
"""
alcubierre_invariants_fd.py

Compute Ricci scalar R and Kretschmann scalar K = R_abcd R^abcd
for an Alcubierre-style metric:

  ds^2 = -dt^2 + (dx - (beta * f(rs)) dt)^2 + dy^2 + dz^2  (c=1)

=> g_tt = -1 + (beta * f)^2
   g_tx = g_xt = -(beta * f)
   g_xx = g_yy = g_zz = 1

We assume a stationary bubble centered at the origin (no x_s(t) translation).
This is intended as an offline invariant-volume generator (small grids).
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np


def sech2_stable(x: np.ndarray) -> np.ndarray:
    a = np.exp(-2.0 * np.abs(x))
    return 4.0 * a / np.square(1.0 + a)


def top_hat(r: np.ndarray, sigma: float, R: float) -> np.ndarray:
    denom = 2.0 * np.tanh(sigma * R)
    denom = denom if abs(denom) > 1e-9 else (1e-9 if denom >= 0 else -1e-9)
    return (np.tanh(sigma * (r + R)) - np.tanh(sigma * (r - R))) / denom


def d_top_hat_dr(r: np.ndarray, sigma: float, R: float) -> np.ndarray:
    denom = 2.0 * np.tanh(sigma * R)
    denom = denom if abs(denom) > 1e-9 else (1e-9 if denom >= 0 else -1e-9)
    return sigma * (sech2_stable(sigma * (r + R)) - sech2_stable(sigma * (r - R))) / denom


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, type=str)
    ap.add_argument("--dims", default=32, type=int, help="Small grid recommended (e.g., 24..40)")
    ap.add_argument("--domainScale", default=1.35, type=float)
    ap.add_argument("--axes", type=float, nargs=3, default=[12.0, 4.0, 4.0])
    ap.add_argument("--sigma", type=float, default=8.0)
    ap.add_argument("--R", type=float, default=1.0)
    ap.add_argument("--beta", type=float, default=0.25)
    ap.add_argument("--float64", action="store_true", help="Use float64 internally (slower, more accurate).")
    args = ap.parse_args()

    dtype = np.float64 if args.float64 else np.float32

    dims = int(args.dims)
    ax, ay, az = (max(1e-6, float(v)) for v in args.axes)
    domain = float(args.domainScale)

    xs = np.linspace(-domain * ax, domain * ax, dims, dtype=dtype)
    ys = np.linspace(-domain * ay, domain * ay, dims, dtype=dtype)
    zs = np.linspace(-domain * az, domain * az, dims, dtype=dtype)
    dx = float(xs[1] - xs[0]) if dims > 1 else 1.0
    dy = float(ys[1] - ys[0]) if dims > 1 else 1.0
    dz = float(zs[1] - zs[0]) if dims > 1 else 1.0

    X, Y, Z = np.meshgrid(xs, ys, zs, indexing="ij")

    # rs = |(x/ax, y/ay, z/az)|
    pMx = X / ax
    pMy = Y / ay
    pMz = Z / az
    rs = np.sqrt(pMx * pMx + pMy * pMy + pMz * pMz)
    rs_safe = np.maximum(rs, 1e-9)

    f = top_hat(rs_safe, float(args.sigma), float(args.R)).astype(dtype)
    dfdr = d_top_hat_dr(rs_safe, float(args.sigma), float(args.R)).astype(dtype)

    # Physical gradients df/dx, df/dy, df/dz (coords are x, y, z).
    dirx = (pMx / rs_safe).astype(dtype)
    diry = (pMy / rs_safe).astype(dtype)
    dirz = (pMz / rs_safe).astype(dtype)
    dfdx = (dfdr * (dirx / ax)).astype(dtype)
    dfdy = (dfdr * (diry / ay)).astype(dtype)
    dfdz = (dfdr * (dirz / az)).astype(dtype)

    beta = float(args.beta)
    bx = (beta * f).astype(dtype)

    # Metric g_{mu nu} on grid: shape (..., 4, 4).
    g = np.zeros((dims, dims, dims, 4, 4), dtype=dtype)
    g[..., 0, 0] = -1.0 + bx * bx
    g[..., 0, 1] = -bx
    g[..., 1, 0] = -bx
    g[..., 1, 1] = 1.0
    g[..., 2, 2] = 1.0
    g[..., 3, 3] = 1.0

    # Analytic inverse: g^{tt}=-1, g^{tx}=-bx, g^{xx}=1-bx^2.
    ginv = np.zeros_like(g)
    ginv[..., 0, 0] = -1.0
    ginv[..., 0, 1] = -bx
    ginv[..., 1, 0] = -bx
    ginv[..., 1, 1] = 1.0 - bx * bx
    ginv[..., 2, 2] = 1.0
    ginv[..., 3, 3] = 1.0

    # dg[mu, ..., a, b] = d_mu g_ab; only spatial derivatives are nonzero.
    dg = np.zeros((4, dims, dims, dims, 4, 4), dtype=dtype)

    dbx_dx = (beta * dfdx).astype(dtype)
    dbx_dy = (beta * dfdy).astype(dtype)
    dbx_dz = (beta * dfdz).astype(dtype)

    # g_tt = -1 + bx^2 => d g_tt = 2 bx d bx
    # g_tx = -bx        => d g_tx = -d bx
    for mu, dbx in [(1, dbx_dx), (2, dbx_dy), (3, dbx_dz)]:
        dg[mu, ..., 0, 0] = 2.0 * bx * dbx
        dg[mu, ..., 0, 1] = -dbx
        dg[mu, ..., 1, 0] = -dbx

    # Christoffels Gamma^a_{bc}.
    Gamma = np.zeros((dims, dims, dims, 4, 4, 4), dtype=dtype)
    for a in range(4):
        for b in range(4):
            for c in range(4):
                acc = np.zeros((dims, dims, dims), dtype=dtype)
                for d in range(4):
                    acc += ginv[..., a, d] * (dg[b, ..., c, d] + dg[c, ..., b, d] - dg[d, ..., b, c])
                Gamma[..., a, b, c] = 0.5 * acc

    # Derivatives of Gamma: only x, y, z.
    dGx, dGy, dGz = np.gradient(Gamma, dx, dy, dz, axis=(0, 1, 2), edge_order=2)
    dGamma = np.zeros((4, dims, dims, dims, 4, 4, 4), dtype=dtype)
    dGamma[1] = dGx
    dGamma[2] = dGy
    dGamma[3] = dGz

    # Riemann R^a_{bcd}.
    Riem = np.zeros((dims, dims, dims, 4, 4, 4, 4), dtype=dtype)
    for a in range(4):
        for b in range(4):
            for c in range(4):
                for d in range(4):
                    term = dGamma[c, ..., a, b, d] - dGamma[d, ..., a, b, c]
                    for e in range(4):
                        term += Gamma[..., a, c, e] * Gamma[..., e, b, d]
                        term -= Gamma[..., a, d, e] * Gamma[..., e, b, c]
                    Riem[..., a, b, c, d] = term

    # Ricci_{bd} = R^a_{bad}.
    Ricci = np.zeros((dims, dims, dims, 4, 4), dtype=dtype)
    for b in range(4):
        for d in range(4):
            s = np.zeros((dims, dims, dims), dtype=dtype)
            for a in range(4):
                s += Riem[..., a, b, a, d]
            Ricci[..., b, d] = s

    # Ricci scalar: R = g^{bd} Ricci_{bd}.
    RicciScalar = np.zeros((dims, dims, dims), dtype=dtype)
    for b in range(4):
        for d in range(4):
            RicciScalar += ginv[..., b, d] * Ricci[..., b, d]

    # Lower first index: R_abcd = g_ae R^e_{bcd}.
    Rcov = np.zeros_like(Riem)
    for a in range(4):
        for b in range(4):
            for c in range(4):
                for d in range(4):
                    s = np.zeros((dims, dims, dims), dtype=dtype)
                    for e in range(4):
                        s += g[..., a, e] * Riem[..., e, b, c, d]
                    Rcov[..., a, b, c, d] = s

    # Kretschmann K = R_abcd R^abcd = R_abcd g^ae g^bf g^cg g^dh R_efgh.
    K = np.einsum(
        "...abcd,...efgh,...ae,...bf,...cg,...dh->...",
        Rcov,
        Rcov,
        ginv,
        ginv,
        ginv,
        ginv,
        optimize=True,
    )

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    meta = {
        "dims": [dims, dims, dims],
        "axes": [ax, ay, az],
        "domainScale": domain,
        "sigma": float(args.sigma),
        "Rshape": float(args.R),
        "beta": beta,
        "notes": "Stationary Alcubierre-style metric invariants (offline FD). Small grids recommended.",
    }

    np.savez_compressed(
        out_path,
        meta_json=np.array([json.dumps(meta)], dtype=object),
        x=xs.astype(np.float32),
        y=ys.astype(np.float32),
        z=zs.astype(np.float32),
        RicciScalar=RicciScalar.astype(np.float32),
        Kretschmann=K.astype(np.float32),
    )

    print(f"Wrote {out_path}")
    print("Fields: RicciScalar, Kretschmann")


if __name__ == "__main__":
    main()
