"""Independent Dirac-spinor reproduction of Peshkov's local Cherenkov Stokes P3.

Exploratory isotropic-medium, fixed-frequency, fixed-angle calculation only.
No radiator transport, finite acceptance, beam degradation, or detector model.
"""

from __future__ import annotations

import math
from dataclasses import dataclass


ELECTRON_REST_ENERGY_EV = 510_998.95069
FINE_STRUCTURE_CONSTANT = 1 / 137.035999084
HC_EV_NM = 1239.8419843320026
ELEMENTARY_CHARGE_C = 1.602176634e-19


@dataclass(frozen=True)
class StokesPoint:
    electron_kinetic_energy_ev: float
    photon_energy_ev: float
    refractive_index: float
    electron_beta: float
    cherenkov_angle_rad: float
    spin_vector: tuple[float, float, float]
    circular_stokes: float
    linear_stokes: float


def _dot(a: tuple[complex, complex], b: tuple[complex, complex]) -> complex:
    return a[0].conjugate() * b[0] + a[1].conjugate() * b[1]


def _pauli_p(p: tuple[float, float, float], chi: tuple[complex, complex]) -> tuple[complex, complex]:
    x, y, z = p
    return (z * chi[0] + (x - 1j * y) * chi[1],
            (x + 1j * y) * chi[0] - z * chi[1])


def _spinor(energy: float, momentum: tuple[float, float, float],
            chi: tuple[complex, complex]) -> tuple[complex, complex, complex, complex]:
    scale = math.sqrt(energy + ELECTRON_REST_ENERGY_EV)
    lower = _pauli_p(momentum, chi)
    return (scale * chi[0], scale * chi[1], lower[0] / scale, lower[1] / scale)


def _sigma_on_spinor(axis: int, chi: tuple[complex, complex]) -> tuple[complex, complex]:
    if axis == 0:
        return chi[1], chi[0]
    if axis == 1:
        return -1j * chi[1], 1j * chi[0]
    return chi[0], -chi[1]


def _current(final: tuple[complex, complex, complex, complex],
             initial: tuple[complex, complex, complex, complex]) -> tuple[complex, complex, complex]:
    final_upper, final_lower = final[:2], final[2:]
    initial_upper, initial_lower = initial[:2], initial[2:]
    return tuple(
        _dot(final_upper, _sigma_on_spinor(axis, initial_lower))
        + _dot(final_lower, _sigma_on_spinor(axis, initial_upper))
        for axis in range(3)
    )


def stokes_point(electron_kinetic_energy_ev: float, photon_energy_ev: float,
                 refractive_index: float,
                 spin_vector: tuple[float, float, float] = (0.0, 0.0, 1.0)) -> StokesPoint:
    """Compute photon Stokes values after summing over the outgoing electron spin.

    Spin_vector is the incoming electron Bloch vector in the reaction-plane
    coordinates: z along electron momentum, x within the reaction plane, y normal.
    """
    if electron_kinetic_energy_ev <= 0 or photon_energy_ev <= 0 or refractive_index <= 1:
        raise ValueError("Positive energies and refractive index above one are required")
    if sum(component * component for component in spin_vector) > 1 + 1e-12:
        raise ValueError("Spin polarization magnitude must not exceed one")
    mass = ELECTRON_REST_ENERGY_EV
    initial_energy = mass + electron_kinetic_energy_ev
    final_energy = initial_energy - photon_energy_ev
    if final_energy <= mass:
        raise ValueError("Outgoing electron must remain on shell")
    initial_p = math.sqrt(initial_energy**2 - mass**2)
    beta = initial_p / initial_energy
    cosine = (1 + photon_energy_ev * (refractive_index**2 - 1)
              / (2 * initial_energy)) / (beta * refractive_index)
    if not -1 <= cosine <= 1:
        raise ValueError("Photon is outside the Cherenkov emission cone")
    angle = math.acos(cosine)
    photon_momentum = photon_energy_ev * refractive_index
    final_p = (-photon_momentum * math.sin(angle), 0.0,
               initial_p - photon_momentum * math.cos(angle))
    initial_momentum = (0.0, 0.0, initial_p)
    electron_basis = ((1 + 0j, 0j), (0j, 1 + 0j))
    final_spinors = [_spinor(final_energy, final_p, chi) for chi in electron_basis]
    initial_spinors = [_spinor(initial_energy, initial_momentum, chi) for chi in electron_basis]
    e_theta = (math.cos(angle), 0.0, -math.sin(angle))
    e_phi = (0.0, 1.0, 0.0)
    photon_vectors = [tuple((e_theta[j] + helicity * 1j * e_phi[j]) / math.sqrt(2)
                            for j in range(3)) for helicity in (+1, -1)]
    amplitudes = [[[sum(current[j] * photon_vectors[helicity][j].conjugate()
                        for j in range(3))
                    for helicity in range(2)]
                   for current in (_current(final, initial) for initial in initial_spinors)]
                  for final in final_spinors]
    px, py, pz = spin_vector
    density = (((1 + pz) / 2, (px - 1j * py) / 2),
               ((px + 1j * py) / 2, (1 - pz) / 2))
    photon_density = [[sum(density[i][j] * amplitudes[f][i][h]
                           * amplitudes[f][j][k].conjugate()
                           for f in range(2) for i in range(2) for j in range(2))
                       for k in range(2)] for h in range(2)]
    norm = (photon_density[0][0] + photon_density[1][1]).real
    circular = (photon_density[0][0] - photon_density[1][1]).real / norm
    linear = 2 * photon_density[0][1].real / norm
    return StokesPoint(electron_kinetic_energy_ev, photon_energy_ev,
                       refractive_index, beta, angle, spin_vector,
                       circular, linear)


def ideal_detected_photons_for_significance(spin_half_difference: float,
                                            sigma: float = 5.0) -> float:
    """Poisson ideal for two equal spin samples and an ideal helicity analyzer.

    A=(P3_plus-P3_minus)/2, and Var(A) approximately equals 1/N_total.
    The result excludes background, gain drift, polarization leakage, and
    all uncertainty in the electron polarization and analyzer calibration.
    """
    if not math.isfinite(spin_half_difference) or spin_half_difference == 0:
        raise ValueError("A nonzero finite asymmetry is required")
    if not math.isfinite(sigma) or sigma <= 0:
        raise ValueError("A positive finite significance is required")
    return (sigma / abs(spin_half_difference)) ** 2


def ideal_band_photons_per_electron(beta: float, refractive_index: float,
                                    center_photon_energy_ev: float,
                                    wavelength_bandwidth_nm: float,
                                    track_length_m: float,
                                    azimuth_span_deg: float = 360) -> float:
    """Frank-Tamm thin-track estimate, constant n, no loss or attenuation.

    Polar acceptance is assumed to include the entire ideal Cherenkov cone.
    Azimuthal emission is assumed uniform. This is an idealized generated-
    photon estimate for the specified channel, not a detected-photon forecast.
    """
    values = (beta, refractive_index, center_photon_energy_ev,
              wavelength_bandwidth_nm, track_length_m, azimuth_span_deg)
    if any(not math.isfinite(value) for value in values):
        raise ValueError("Finite inputs are required")
    if not (0 < beta < 1 and refractive_index > 1 and
            center_photon_energy_ev > 0 and wavelength_bandwidth_nm > 0 and
            track_length_m > 0 and 0 < azimuth_span_deg <= 360):
        raise ValueError("Invalid band-yield inputs")
    wavelength_nm = HC_EV_NM / center_photon_energy_ev
    wavelength_min_m = (wavelength_nm - wavelength_bandwidth_nm / 2) * 1e-9
    wavelength_max_m = (wavelength_nm + wavelength_bandwidth_nm / 2) * 1e-9
    if wavelength_min_m <= 0:
        raise ValueError("Band must have positive wavelengths")
    threshold_factor = 1 - 1 / (beta * refractive_index) ** 2
    if threshold_factor <= 0:
        return 0.0
    return (2 * math.pi * FINE_STRUCTURE_CONSTANT * track_length_m
            * threshold_factor * (1 / wavelength_min_m - 1 / wavelength_max_m)
            * azimuth_span_deg / 360)


if __name__ == "__main__":
    for spin in ((0, 0, 1), (0, 0, -1), (0, 1, 0), (-1, 0, 0), (0, 0, 0)):
        result = stokes_point(500_000, 2.104, 1.33, spin)
        print(spin, result.electron_beta, math.degrees(result.cherenkov_angle_rad),
              result.circular_stokes, result.linear_stokes)
    point = stokes_point(500_000, 2.104, 1.33)
    polarized_asymmetry = 0.8 * point.circular_stokes
    photons = ideal_detected_photons_for_significance(polarized_asymmetry)
    channel_yield = ideal_band_photons_per_electron(
        point.electron_beta, 1.33, 2.104, 10, 10e-6, 10)
    print("ideal_80pct_5sigma_detected_photons", photons)
    print("ideal_10um_10nm_10deg_generated_photons_per_electron", channel_yield)
    print("ideal_minimum_electrons", photons / channel_yield)
    print("ideal_minimum_charge_coulombs", photons / channel_yield * ELEMENTARY_CHARGE_C)
