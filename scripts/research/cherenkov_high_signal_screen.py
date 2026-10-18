"""Exploratory local spin-Cherenkov sensitivity screen.

Uses the source-matched isotropic model, ideal Frank-Tamm channel yield, and
Poisson statistics. Structured-mode gains are algebraic scenarios, not QED
predictions or experimental performance claims.
"""

from __future__ import annotations

import json
import math

from cherenkov_spin_stokes_reproduction import (
    ideal_band_photons_per_electron,
    stokes_point,
)


PHOTON_ENERGY_EV = 2.104
REFRACTIVE_INDEX = 1.33
TRACK_LENGTH_M = 10e-6
BANDWIDTH_NM = 10.0
AZIMUTH_DEG = 10.0


def model_row(kinetic_energy_kev: float) -> dict[str, float]:
    point = stokes_point(
        kinetic_energy_kev * 1_000, PHOTON_ENERGY_EV, REFRACTIVE_INDEX
    )
    generated_yield = ideal_band_photons_per_electron(
        point.electron_beta,
        REFRACTIVE_INDEX,
        PHOTON_ENERGY_EV,
        BANDWIDTH_NM,
        TRACK_LENGTH_M,
        AZIMUTH_DEG,
    )
    return {
        "kinetic_energy_kev": kinetic_energy_kev,
        "spin_odd_circular_stokes_full_polarization": point.circular_stokes,
        "ideal_generated_channel_photons_per_electron": generated_yield,
        "ideal_shot_noise_proxy_per_sqrt_electron": (
            abs(point.circular_stokes) * math.sqrt(generated_yield)
        ),
    }


def required_contrast_gain(yield_ratio: float, target_information_gain: float) -> float:
    """For FOM gain = contrast gain * sqrt(detected-yield ratio)."""
    if yield_ratio <= 0 or target_information_gain <= 0:
        raise ValueError("Positive ratios are required")
    return target_information_gain / math.sqrt(yield_ratio)


def main() -> None:
    rows = [model_row(energy) for energy in (270, 300, 400, 500, 700, 1_000)]
    baseline = next(row for row in rows if row["kinetic_energy_kev"] == 500)
    for row in rows:
        row["relative_shot_noise_proxy_vs_500kev"] = (
            row["ideal_shot_noise_proxy_per_sqrt_electron"]
            / baseline["ideal_shot_noise_proxy_per_sqrt_electron"]
        )
        row["relative_incident_electrons_for_same_significance"] = (
            1 / row["relative_shot_noise_proxy_vs_500kev"] ** 2
        )
    print(json.dumps({
        "model": "isotropic constant-n Peshkov point and ideal Frank-Tamm yield",
        "channel": {
            "photon_energy_ev": PHOTON_ENERGY_EV,
            "refractive_index": REFRACTIVE_INDEX,
            "track_length_m": TRACK_LENGTH_M,
            "bandwidth_nm": BANDWIDTH_NM,
            "azimuth_deg": AZIMUTH_DEG,
        },
        "energy_scan": rows,
        "structured_scenario_requirement": {
            "meaning": "minimum contrast gain for 10x shot-noise FOM at a given detected-yield ratio; not a physical structure prediction",
            "yield_ratio_1": required_contrast_gain(1, 10),
            "yield_ratio_0_1": required_contrast_gain(0.1, 10),
            "yield_ratio_0_01": required_contrast_gain(0.01, 10),
            "yield_ratio_0_0001": required_contrast_gain(0.0001, 10),
        },
    }, indent=2))


if __name__ == "__main__":
    main()
