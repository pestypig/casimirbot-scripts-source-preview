#!/usr/bin/env python3
"""Build the compact, provenance-bound Stage-4.2O public-data fixture.

The source archives remain external.  This importer verifies their complete-file
SHA-256 digests and emits only the numerical summaries needed by the repository
runtime.  The four apparatuses are deliberately kept in separate namespaces;
there is no cross-apparatus covariance or joint estimator.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import os
import re
import zipfile
from pathlib import Path
import xml.etree.ElementTree as ET

import numpy as np
from astropy.io import fits


SOURCES = {
    "sodium": {
        "filename": "Na-Cluster-Interference.zip",
        "sha256": "b92355d06e06f16b3c746020ef7bc6c6eac6a629d36d739aff79e6a894003b9a",
        "url": "https://zenodo.org/api/records/17502163/files/Na-Cluster-Interference.zip/content",
        "record": "https://doi.org/10.5281/zenodo.17502163",
    },
    "casimir": {
        "filename": "Casimir_drums_data.zip",
        "sha256": "f79908a4203b623ccb7b3b7c21c19d9538000f419d342dda124583c284b53055",
        "url": "https://zenodo.org/api/records/18682702/files/Casimir_drums_data.zip/content",
        "record": "https://doi.org/10.5281/zenodo.18682702",
    },
    "lisa_pathfinder": {
        "filename": "drs_20160917_235626__20160924_235557.fits",
        "sha256": "66a1a18e93b5cdbbcd67cbcab9a08bcbb8862542ef98b9ba9c72e27ec8de421d",
        "url": "https://heasarc.gsfc.nasa.gov/FTP/lpf/data/fits/drs_20160917_235626__20160924_235557.fits",
        "record": "https://heasarc.gsfc.nasa.gov/w3browse/all/lpffiles.html",
    },
    "gran_sasso_fig3": {
        "filename": "gran-sasso-fig3.xlsx",
        "sha256": "ef86fe9fac36fcee81c0a762571737950c5cccbc7343178593743199ef6e5e23",
        "url": "https://media.springernature.com/original/springer-static/esm/art%3A10.1038%2Fs41567-020-1008-4/MediaObjects/41567_2020_1008_MOESM2_ESM.xlsx",
        "record": "https://doi.org/10.1038/s41567-020-1008-4",
    },
    "gran_sasso_fig4": {
        "filename": "gran-sasso-fig4.xlsx",
        "sha256": "29a1f3ad10ee59e00bc5feb3a81453b9728ab6113151cb30f1b92cad78d3d6d7",
        "url": "https://media.springernature.com/original/springer-static/esm/art%3A10.1038%2Fs41567-020-1008-4/MediaObjects/41567_2020_1008_MOESM3_ESM.xlsx",
        "record": "https://doi.org/10.1038/s41567-020-1008-4",
    },
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def verified_path(source_dir: Path, source_id: str) -> Path:
    source = SOURCES[source_id]
    path = source_dir / source["filename"]
    if not path.is_file():
        raise FileNotFoundError(f"stage4_2o_missing_source:{path}")
    actual = sha256_file(path)
    if actual != source["sha256"]:
        raise ValueError(f"stage4_2o_source_hash_mismatch:{source_id}:{actual}")
    return path


def source_receipt(source_id: str, path: Path) -> dict:
    source = SOURCES[source_id]
    return {
        "source_id": source_id,
        "filename": source["filename"],
        "url": source["url"],
        "record": source["record"],
        "expected_sha256": source["sha256"],
        "actual_sha256": sha256_file(path),
        "integrity_verified": True,
    }


def sodium_fringe_recovery(path: Path) -> dict:
    period_nm = 133.0
    nominal_bin_nm = 15.0
    bin_count = round(period_nm / nominal_bin_nm)
    rows = []
    pattern = re.compile(r"Sodium_int_powerscan_(\d+)_s1\.dat$")
    with zipfile.ZipFile(path) as archive:
        members = []
        for member in archive.namelist():
            match = pattern.search(member)
            if match:
                members.append((int(match.group(1)), member))
        for scan_id, member in sorted(members):
            data = np.loadtxt(io.BytesIO(archive.read(member)), delimiter="\t")
            positions_nm = data[:, 0]
            counts = data[:, 1]
            modulo = np.mod(positions_nm, period_nm)
            edges = np.linspace(0.0, period_nm, bin_count + 1)
            means = []
            for index in range(bin_count):
                if index == bin_count - 1:
                    mask = (modulo >= edges[index]) & (modulo <= edges[index + 1])
                else:
                    mask = (modulo >= edges[index]) & (modulo < edges[index + 1])
                if not np.any(mask):
                    raise ValueError(f"stage4_2o_empty_sodium_bin:{scan_id}:{index}")
                means.append(float(np.mean(counts[mask])))
            fourier = np.fft.fft(np.asarray(means)) / bin_count
            coefficient = 2.0 * fourier[1] / fourier[0]
            coefficient *= np.exp(-2j * np.pi * (nominal_bin_nm / 2.0) / period_nm)
            rows.append({
                "scan_id": scan_id,
                "sample_count": int(len(counts)),
                "mean_counts": float(np.mean(counts)),
                "coefficient_re": float(coefficient.real),
                "coefficient_im": float(coefficient.imag),
                "visibility": float(abs(coefficient)),
                "phase_rad": float(np.angle(coefficient)),
            })
    coefficients = np.array([[row["coefficient_re"], row["coefficient_im"]] for row in rows])
    train = coefficients[::2]
    holdout = coefficients[1::2]
    return {
        "role": "complex_fringe_recovery",
        "observable_definition": "C1=2*S1/S0=V*exp(i*phi), after the registered finite-bin phase correction",
        "period_nm": period_nm,
        "nominal_bin_nm": nominal_bin_nm,
        "scan_count": len(rows),
        "scans": rows,
        "alternating_split": {
            "train_count": int(len(train)),
            "holdout_count": int(len(holdout)),
            "train_mean_complex": [float(x) for x in train.mean(axis=0)],
            "holdout_mean_complex": [float(x) for x in holdout.mean(axis=0)],
            "train_covariance": np.cov(train, rowvar=False).tolist(),
            "holdout_covariance": np.cov(holdout, rowvar=False).tolist(),
        },
        "claim_boundary": "This is a measured matter-wave fringe coefficient, not the density-matrix element of the proposed sphere and not evidence for collapse.",
    }


def spectral_centroids(frequencies: np.ndarray, powers_db: np.ndarray) -> np.ndarray:
    flat_f = frequencies.reshape((frequencies.shape[0], -1))
    flat_p = powers_db.reshape((powers_db.shape[0], -1))
    peak = np.max(flat_p, axis=0, keepdims=True)
    weights = np.power(10.0, (flat_p - peak) / 10.0)
    denominator = np.sum(weights, axis=0)
    if np.any(denominator <= 0):
        raise ValueError("stage4_2o_invalid_casimir_trace_weight")
    return np.sum(flat_f * weights, axis=0) / denominator


def casimir_boundary_recovery(path: Path) -> dict:
    members = {
        "frequencies": "Raw and filtered data/2024-03-22-0918_filtfreqs.npy",
        "down": "Raw and filtered data/2024-03-22-0918_filtdata_down.npy",
        "up": "Raw and filtered data/2024-03-22-0918_filtdata_up.npy",
    }
    with zipfile.ZipFile(path) as archive:
        arrays = {
            key: np.load(io.BytesIO(archive.read(member)), allow_pickle=False)
            for key, member in members.items()
        }
    frequencies = arrays["frequencies"].astype(float)
    down = arrays["down"].astype(float)
    up = arrays["up"].astype(float)
    if frequencies.shape != down.shape or frequencies.shape != up.shape:
        raise ValueError("stage4_2o_casimir_shape_mismatch")
    down_centroid = spectral_centroids(frequencies, down)
    up_centroid = spectral_centroids(frequencies, up)
    shift = up_centroid - down_centroid
    paired = np.column_stack([down_centroid, up_centroid])
    return {
        "role": "measured_boundary_response_recovery",
        "dataset_description": "Filtered upward/downward microwave-drive traces from the superconducting-drum experiment.",
        "array_shape": list(frequencies.shape),
        "trace_count": int(len(shift)),
        "down_centroid_Hz": down_centroid.tolist(),
        "up_centroid_Hz": up_centroid.tolist(),
        "paired_centroid_covariance_Hz2": np.cov(paired, rowvar=False).tolist(),
        "up_minus_down_shift": {
            "mean_Hz": float(np.mean(shift)),
            "rms_Hz": float(np.sqrt(np.mean(np.square(shift)))),
            "median_absolute_Hz": float(np.median(np.abs(shift))),
            "p95_absolute_Hz": float(np.quantile(np.abs(shift), 0.95)),
        },
        "claim_boundary": "The replay establishes a measured nonlinear paired boundary/drive response only; it neither independently identifies the force nor calibrates the proposed Casimir-Diosi apparatus.",
    }


def lisa_covariance_recovery(path: Path) -> dict:
    channels = [
        "DST11004", "DST12004", "DST13004", "DST14004",
        "DST15004", "DST16004", "DST17004", "DST18004",
        "DST11005", "DST12005", "DST13005", "DST14005",
        "DST15005", "DST16005", "DST17005", "DST18005",
    ]
    with fits.open(path, memmap=True) as hdus:
        table = hdus["SCI_SCIENCE_1Hz"].data
        matrix = np.column_stack([np.asarray(table[name], dtype=float) for name in channels])
    active = np.all(np.isfinite(matrix), axis=1) & np.any(matrix != 0.0, axis=1)
    matrix = matrix[active]
    window_size = 60
    full_windows = len(matrix) // window_size
    windowed = matrix[: full_windows * window_size].reshape(full_windows, window_size, len(channels)).mean(axis=1)
    split = full_windows // 2
    train_raw = windowed[:split]
    holdout_raw = windowed[split:]
    means = train_raw.mean(axis=0)
    scales = train_raw.std(axis=0, ddof=1)
    if np.any(scales <= 0):
        raise ValueError("stage4_2o_lisa_zero_scale")
    train = (train_raw - means) / scales
    holdout = (holdout_raw - means) / scales
    train_cov = np.cov(train, rowvar=False)
    holdout_cov = np.cov(holdout, rowvar=False)
    shrinkage = 0.05
    train_shrunk = (1.0 - shrinkage) * train_cov + shrinkage * np.eye(len(channels))
    holdout_shrunk = (1.0 - shrinkage) * holdout_cov + shrinkage * np.eye(len(channels))
    design_train = np.column_stack([np.ones(len(train)), train[:, 1:]])
    design_holdout = np.column_stack([np.ones(len(holdout)), holdout[:, 1:]])
    beta, *_ = np.linalg.lstsq(design_train, train[:, 0], rcond=None)
    train_residual = train[:, 0] - design_train @ beta
    holdout_residual = holdout[:, 0] - design_holdout @ beta
    covariance_drift = np.linalg.norm(holdout_cov - train_cov, ord="fro") / np.linalg.norm(train_cov, ord="fro")
    return {
        "role": "multichannel_covariance_recovery",
        "channel_ids": channels,
        "channel_semantics": [
            "thruster 1 beam voltage", "thruster 2 beam voltage",
            "thruster 3 beam voltage", "thruster 4 beam voltage",
            "thruster 5 beam voltage", "thruster 6 beam voltage",
            "thruster 7 beam voltage", "thruster 8 beam voltage",
            "thruster 1 beam current", "thruster 2 beam current",
            "thruster 3 beam current", "thruster 4 beam current",
            "thruster 5 beam current", "thruster 6 beam current",
            "thruster 7 beam current", "thruster 8 beam current",
        ],
        "active_row_count": int(len(matrix)),
        "window_size_s": window_size,
        "train_window_count": int(len(train)),
        "holdout_window_count": int(len(holdout)),
        "standardization_mean_SI": means.tolist(),
        "standardization_scale_SI": scales.tolist(),
        "shrinkage_fraction": shrinkage,
        "train_covariance": train_cov.tolist(),
        "holdout_covariance": holdout_cov.tolist(),
        "train_shrunk_condition_number": float(np.linalg.cond(train_shrunk)),
        "holdout_shrunk_condition_number": float(np.linalg.cond(holdout_shrunk)),
        "relative_covariance_drift": float(covariance_drift),
        "linear_residual": {
            "target_channel": channels[0],
            "train_rmse_standardized": float(np.sqrt(np.mean(np.square(train_residual)))),
            "holdout_rmse_standardized": float(np.sqrt(np.mean(np.square(holdout_residual)))),
            "holdout_mean_standardized": float(np.mean(holdout_residual)),
        },
        "claim_boundary": "This is a classical spacecraft metrology replay for covariance and held-out residual handling; it is not a quantum-coherence, Casimir, or collapse measurement.",
    }


def read_first_xlsx_sheet(path: Path) -> list[list[object]]:
    main_ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    rel_ns = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    with zipfile.ZipFile(path) as archive:
        shared = []
        if "xl/sharedStrings.xml" in archive.namelist():
            root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            for item in root.findall(f"{{{main_ns}}}si"):
                shared.append("".join(node.text or "" for node in item.iter(f"{{{main_ns}}}t")))
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        relationship_id = workbook.find(f".//{{{main_ns}}}sheet").attrib[f"{{{rel_ns}}}id"]
        relationships = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        target = next(node.attrib["Target"] for node in relationships if node.attrib["Id"] == relationship_id)
        member = target if target.startswith("xl/") else f"xl/{target.lstrip('/')}"
        sheet = ET.fromstring(archive.read(member))
    rows = []
    for row in sheet.findall(f".//{{{main_ns}}}sheetData/{{{main_ns}}}row"):
        values: dict[int, object] = {}
        for cell in row.findall(f"{{{main_ns}}}c"):
            address = cell.attrib["r"]
            letters = "".join(char for char in address if char.isalpha())
            column = 0
            for char in letters:
                column = column * 26 + ord(char.upper()) - 64
            value_node = cell.find(f"{{{main_ns}}}v")
            if value_node is None:
                value: object = None
            elif cell.attrib.get("t") == "s":
                value = shared[int(value_node.text)]
            else:
                value = float(value_node.text)
            values[column - 1] = value
        width = max(values.keys(), default=-1) + 1
        rows.append([values.get(index) for index in range(width)])
    return rows


def gran_sasso_bound_recovery(fig3_path: Path, fig4_path: Path) -> dict:
    fig3 = read_first_xlsx_sheet(fig3_path)
    fig4 = read_first_xlsx_sheet(fig4_path)
    spectrum = np.asarray([[float(row[0]), float(row[1])] for row in fig3[1:] if len(row) >= 2], dtype=float)
    comparison = np.asarray([[float(row[0]), float(row[1]), float(row[2])] for row in fig4[1:] if len(row) >= 3], dtype=float)
    pearson = float(np.corrcoef(comparison[:, 1], comparison[:, 2])[0, 1])
    return {
        "role": "external_dp_bound",
        "paper_result": "The parameter-free natural Diosi-Penrose model is ruled out by the published underground spontaneous-radiation search.",
        "fig3": {
            "bin_count": int(len(spectrum)),
            "energy_min_keV": float(spectrum[:, 0].min()),
            "energy_max_keV": float(spectrum[:, 0].max()),
            "total_counts": float(spectrum[:, 1].sum()),
        },
        "fig4": {
            "bin_count": int(len(comparison)),
            "energy_min_keV": float(comparison[:, 0].min()),
            "energy_max_keV": float(comparison[:, 0].max()),
            "data_total_counts": float(comparison[:, 1].sum()),
            "simulation_total_counts": float(comparison[:, 2].sum()),
            "data_simulation_pearson": pearson,
        },
        "registered_stage4_2o_model_adjudication": "not_adjudicated",
        "claim_boundary": "The source-data replay authenticates the external bound record. It does not transfer the parameter-free exclusion to the separately regularized R0=100 nm comparator without a variant-matched bound calculation.",
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    source_dir = args.source_dir.resolve()
    paths = {source_id: verified_path(source_dir, source_id) for source_id in SOURCES}
    fixture = {
        "schema_version": "casimir_dp_public_data_component_fixture_stage4_2o/1",
        "evidence_class": "external_public_component_measurements_only",
        "cross_apparatus_covariance_fusion": False,
        "sources": {source_id: source_receipt(source_id, path) for source_id, path in paths.items()},
        "components": {
            "sodium": sodium_fringe_recovery(paths["sodium"]),
            "casimir": casimir_boundary_recovery(paths["casimir"]),
            "lisa_pathfinder": lisa_covariance_recovery(paths["lisa_pathfinder"]),
            "gran_sasso": gran_sasso_bound_recovery(paths["gran_sasso_fig3"], paths["gran_sasso_fig4"]),
        },
        "joint_protocol_cells_present": False,
        "leading_design_modified": False,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(fixture, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps({
        "output": str(args.output),
        "sha256": sha256_file(args.output),
        "sodium_scans": fixture["components"]["sodium"]["scan_count"],
        "casimir_traces": fixture["components"]["casimir"]["trace_count"],
        "lisa_active_rows": fixture["components"]["lisa_pathfinder"]["active_row_count"],
        "gran_sasso_fig4_bins": fixture["components"]["gran_sasso"]["fig4"]["bin_count"],
    }, indent=2))


if __name__ == "__main__":
    main()
