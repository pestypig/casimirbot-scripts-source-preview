"""Bounds and scales for a spin-conditioned coherent cavity-reflection lead.

Exploratory arithmetic only. Conditional Stokes purities from different delays
and cavity reflectivities from a different paper/device are deliberately kept
separate; the script does not multiply them into a claimed apparatus SNR.
"""

from __future__ import annotations

import json
import math


LIGHT_SPEED_M_S = 299_792_458.0
STANDARD_GRAVITY_M_S2 = 9.80665


def stokes_trace_distance(
    purity_plus: float, purity_minus: float, angle_deg: float
) -> float:
    """Trace distance of two normalized polarization qubits from Bloch vectors."""
    if not 0 <= purity_plus <= 1 or not 0 <= purity_minus <= 1:
        raise ValueError("Stokes-vector lengths must lie in [0, 1]")
    if not 0 <= angle_deg <= 180:
        raise ValueError("Relative angle must lie in [0, 180] degrees")
    angle = math.radians(angle_deg)
    return math.sqrt(
        purity_plus**2 + purity_minus**2
        - 2 * purity_plus * purity_minus * math.cos(angle)
    ) / 2


def equal_jones_spin_distance(
    co_amplitude: complex, cross_amplitude: complex
) -> tuple[float, float]:
    """Ideal |a H +/- b V> model: return overlap squared and trace distance."""
    total = abs(co_amplitude) ** 2 + abs(cross_amplitude) ** 2
    if total <= 0:
        raise ValueError("Nonzero reflection amplitude required")
    overlap_sq = (
        (abs(co_amplitude) ** 2 - abs(cross_amplitude) ** 2) / total
    ) ** 2
    return overlap_sq, math.sqrt(max(0.0, 1 - overlap_sq))


def redshift_scale(wavelength_nm: float, height_m: float) -> dict[str, float]:
    """Leading-order stationary weak-field comparison scale, no link noise."""
    if wavelength_nm <= 0 or height_m <= 0:
        raise ValueError("Positive wavelength and height are required")
    epsilon = STANDARD_GRAVITY_M_S2 * height_m / LIGHT_SPEED_M_S**2
    frequency_hz = LIGHT_SPEED_M_S / (wavelength_nm * 1e-9)
    difference_hz = frequency_hz * epsilon
    return {
        "wavelength_nm": wavelength_nm,
        "height_m": height_m,
        "fractional_gravitational_shift": epsilon,
        "ordinary_frequency_difference_hz": difference_hz,
        "ordinary_phase_rate_rad_s": 2 * math.pi * difference_hz,
        "spin_odd_half_difference_hz_if_eta_1e_minus_3": 1e-3 * difference_hz,
    }


def main() -> None:
    ideal_overlap_sq, ideal_distance = equal_jones_spin_distance(1, 1)
    print(json.dumps({
        "ideal_equal_amplitude_cavity_model": {
            "spin_state_overlap_squared": ideal_overlap_sq,
            "polarization_trace_distance_per_reflected_photon": ideal_distance,
            "status": "algebraic ceiling, not measured device contrast",
        },
        "2026_preprint_conditional_stokes_proxies": {
            "source": "arXiv:2609.03910; ~171 degree separation, purity ~0.6 to ~0.2 over 1-2 ns",
            "distance_if_both_purities_0_6": stokes_trace_distance(.6, .6, 171),
            "distance_if_both_purities_0_2": stokes_trace_distance(.2, .2, 171),
            "status": "conditional heralded photons; not prepared-spin reversal contrast",
        },
        "2024_published_reflection_efficiencies": {
            "source": "Nature Communications 15, 598 (2024); different device from 2026 preprint",
            "at_1_3_t": .15,
            "at_1_7_t": .35,
            "at_2_1_t": .60,
            "status": "reflection fractions at different optical settings; not detected link yields",
        },
        "100m_gravity_scale_for_925nm_probe": redshift_scale(925, 100),
    }, indent=2))


if __name__ == "__main__":
    main()
