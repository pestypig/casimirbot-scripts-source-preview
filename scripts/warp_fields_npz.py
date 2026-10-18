#!/usr/bin/env python3
"""
warp_fields_npz.py

Generate 3D scalar fields used by the Hull3D analytic viz:
  - theta_gr
  - rho_gr
  - shear_gr (sigma2)
  - vorticity_gr
  - theta_drive (theta_gr * ampChain * gate_view * gateWF)

This mirrors the GLSL math in:
  client/src/components/AlcubierrePanel.tsx (vertex shader path)
See the block computing dfdr/dfx, theta_gr, rho_gr, sigma2, vorticity, gateWF, theta_drive.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np


def sech2_stable(x: np.ndarray) -> np.ndarray:
    # sech^2(x) = 4 * a / (1 + a)^2 where a = exp(-2|x|)
    a = np.exp(-2.0 * np.abs(x))
    return 4.0 * a / np.square(1.0 + a)


def top_hat(r: np.ndarray, sigma: float, R: float) -> np.ndarray:
    denom = 2.0 * np.tanh(sigma * R)
    denom = denom if abs(denom) > 1e-9 else (1e-9 if denom >= 0 else -1e-9)
    return (np.tanh(sigma * (r + R)) - np.tanh(sigma * (r - R))) / denom


def d_top_hat_dr(r: np.ndarray, sigma: float, R: float) -> np.ndarray:
    # Matches AlcubierrePanel.tsx GLSL dTopHatDr.
    denom = 2.0 * np.tanh(sigma * R)
    denom = denom if abs(denom) > 1e-9 else (1e-9 if denom >= 0 else -1e-9)
    return sigma * (sech2_stable(sigma * (r + R)) - sech2_stable(sigma * (r - R))) / denom


@dataclass
class GateParams:
    total_sectors: int = 400
    live_sectors: int = 1
    sector_floor: float = 0.10
    lump_exp: float = 1.0
    sync_mode: int = 1
    sector_center01: float = 0.10
    sector_sigma01: float = 0.35
    phase01: float = 0.0
    split_enabled: int = 0
    split_frac: float = 0.5


def gate_weight(a01: np.ndarray, gp: GateParams) -> np.ndarray:
    """
    Mirrors the gateWF block in AlcubierrePanel.tsx GLSL:
      - build wNorm either gaussian or contiguous,
      - gateWF = pow(sqrt(max(0, wNorm)), max(0.5, lumpExp))
    """
    total = max(1, int(gp.total_sectors))
    live = max(1, min(int(gp.live_sectors), total))

    a01 = (a01 + (gp.phase01 % 1.0)) % 1.0

    floor_frac = float(np.clip(gp.sector_floor, 0.0, 0.99))
    peak_frac = 1.0 - floor_frac

    if gp.sync_mode == 1:
        center = gp.sector_center01 % 1.0
        sigma01 = max(1e-4, float(gp.sector_sigma01))
        dist = np.abs(a01 - center)
        dist = np.minimum(dist, 1.0 - dist)
        g1 = np.exp(-0.5 * (dist * dist) / (sigma01 * sigma01))
        g = g1
        if gp.split_enabled == 1:
            center2 = (center + 0.5) % 1.0
            dist2 = np.abs(a01 - center2)
            dist2 = np.minimum(dist2, 1.0 - dist2)
            g2 = np.exp(-0.5 * (dist2 * dist2) / (sigma01 * sigma01))
            wA = float(np.clip(gp.split_frac, 0.0, 1.0))
            g = g1 * wA + g2 * (1.0 - wA)

        # Shader uses approx average gaussian: avgG = min(1.0, sigma01 * 2.5066283)
        avgG = min(1.0, sigma01 * 2.5066283)
        g_norm = np.minimum(g / max(avgG, 1e-4), 12.0)
        w_norm = floor_frac + peak_frac * g_norm
    else:
        # Contiguous fallback (shader stable path).
        s_idx = np.floor(a01 * float(total)).astype(np.int32)
        on = (s_idx < live).astype(np.float32)
        frac = max(1.0 / float(total), float(live) / float(total))
        norm = np.minimum(on / max(frac, 1e-9), 12.0)
        w_norm = floor_frac + peak_frac * norm

    gate_wf = np.power(np.sqrt(np.maximum(0.0, w_norm)), max(0.5, float(gp.lump_exp)))
    return gate_wf.astype(np.float32)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=str, required=True, help="Output .npz path")
    ap.add_argument("--dims", type=int, default=128, help="Grid resolution per axis (Nx=Ny=Nz=dims)")
    ap.add_argument("--domainScale", type=float, default=1.35, help="Extent in multiples of axes half-length")
    ap.add_argument("--axes", type=float, nargs=3, default=[12.0, 4.0, 4.0], metavar=("AX", "AY", "AZ"))
    ap.add_argument("--sigma", type=float, default=8.0)
    ap.add_argument("--R", type=float, default=1.0)
    ap.add_argument("--beta", type=float, default=0.2)
    ap.add_argument("--thetaSign", type=float, default=1.0)
    ap.add_argument("--ampChain", type=float, default=1.0, help="gamma_geo^3 * q * gamma_VdB")
    ap.add_argument("--gateView", type=float, default=1.0, help="viewer gate multiplier (u_gate_view)")
    ap.add_argument("--totalSectors", type=int, default=400)
    ap.add_argument("--liveSectors", type=int, default=1)
    ap.add_argument("--sectorFloor", type=float, default=0.10)
    ap.add_argument("--lumpExp", type=float, default=1.0)
    ap.add_argument("--syncMode", type=int, default=1, choices=[0, 1], help="1=gaussian, 0=contiguous")
    ap.add_argument("--sectorCenter01", type=float, default=0.10)
    ap.add_argument("--sectorSigma01", type=float, default=0.35)
    ap.add_argument("--phase01", type=float, default=0.0)
    ap.add_argument("--splitEnabled", type=int, default=0, choices=[0, 1])
    ap.add_argument("--splitFrac", type=float, default=0.5)
    args = ap.parse_args()

    dims = int(args.dims)
    ax, ay, az = (max(1e-6, float(v)) for v in args.axes)
    domain = float(args.domainScale)

    # Grid in view coords: x in [-domain*ax, domain*ax], etc.
    xs = np.linspace(-domain * ax, domain * ax, dims, dtype=np.float32)
    ys = np.linspace(-domain * ay, domain * ay, dims, dtype=np.float32)
    zs = np.linspace(-domain * az, domain * az, dims, dtype=np.float32)
    X, Y, Z = np.meshgrid(xs, ys, zs, indexing="ij")

    # Metric radius rs = length(pView / axes).
    pMx = X / ax
    pMy = Y / ay
    pMz = Z / az
    rs = np.sqrt(pMx * pMx + pMy * pMy + pMz * pMz).astype(np.float32)
    rs_safe = np.maximum(rs, 1e-6)

    dfdr = d_top_hat_dr(rs_safe, float(args.sigma), float(args.R)).astype(np.float32)
    dirx = (pMx / rs_safe).astype(np.float32)
    diry = (pMy / rs_safe).astype(np.float32)
    dirz = (pMz / rs_safe).astype(np.float32)

    # Mirror the GLSL: dfx = dfdr * dir.x (no extra /ax factor).
    dfx = dfdr * dirx
    dfy = dfdr * diry
    dfz = dfdr * dirz

    beta = float(args.beta)
    theta_sign = float(args.thetaSign)

    theta_gr = (beta * dfx * theta_sign).astype(np.float32)

    # K components (flat gamma_ij assumption).
    Kxx = (-beta * dfx).astype(np.float32)
    Kxy = (-0.5 * beta * dfy).astype(np.float32)
    Kxz = (-0.5 * beta * dfz).astype(np.float32)

    K2 = (Kxx * Kxx).astype(np.float32)
    KijKij = (Kxx * Kxx + 2.0 * (Kxy * Kxy + Kxz * Kxz)).astype(np.float32)

    inv16pi = np.float32(1.0 / (16.0 * np.pi))
    rho_gr = ((K2 - KijKij) * inv16pi).astype(np.float32)

    shear_gr = np.maximum(KijKij - (K2 / 3.0), 0.0).astype(np.float32)

    # Vorticity: shader uses beta * sqrt(dfy^2 + dfz^2).
    vorticity_gr = (beta * np.sqrt(dfy * dfy + dfz * dfz)).astype(np.float32)

    # theta_drive gate: azimuth uses atan(z, x) in view coords.
    ang = np.arctan2(Z.astype(np.float32), X.astype(np.float32))
    a01 = (np.mod(ang, 2.0 * np.pi) / (2.0 * np.pi)).astype(np.float32)

    gp = GateParams(
        total_sectors=int(args.totalSectors),
        live_sectors=int(args.liveSectors),
        sector_floor=float(args.sectorFloor),
        lump_exp=float(args.lumpExp),
        sync_mode=int(args.syncMode),
        sector_center01=float(args.sectorCenter01),
        sector_sigma01=float(args.sectorSigma01),
        phase01=float(args.phase01),
        split_enabled=int(args.splitEnabled),
        split_frac=float(args.splitFrac),
    )
    gate_wf = gate_weight(a01, gp)
    theta_drive = (theta_gr * float(args.ampChain) * float(args.gateView) * gate_wf).astype(np.float32)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    meta = {
        "dims": [dims, dims, dims],
        "axes": [ax, ay, az],
        "domainScale": domain,
        "sigma": float(args.sigma),
        "R": float(args.R),
        "beta": beta,
        "thetaSign": theta_sign,
        "ampChain": float(args.ampChain),
        "gateView": float(args.gateView),
        "gateParams": gp.__dict__,
        "notes": "Fields mirror AlcubierrePanel.tsx GLSL (analytic viz path).",
    }

    np.savez_compressed(
        out_path,
        meta_json=np.array([json.dumps(meta)], dtype=object),
        x=xs,
        y=ys,
        z=zs,
        theta_gr=theta_gr,
        rho_gr=rho_gr,
        shear_gr=shear_gr,
        vorticity_gr=vorticity_gr,
        theta_drive=theta_drive,
        gateWF=gate_wf.astype(np.float32),
    )

    print(f"Wrote {out_path}")
    print("Fields: theta_gr rho_gr shear_gr vorticity_gr theta_drive gateWF")


if __name__ == "__main__":
    main()
