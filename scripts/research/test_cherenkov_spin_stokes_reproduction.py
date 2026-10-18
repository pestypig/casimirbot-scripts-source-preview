import math
import unittest

from cherenkov_spin_stokes_reproduction import (
    ideal_band_photons_per_electron,
    ideal_detected_photons_for_significance,
    stokes_point,
)


class CherenkovSpinStokesReproductionTests(unittest.TestCase):
    def test_reproduces_peshkov_paper_point_and_spin_controls(self):
        plus = stokes_point(500_000, 2.104, 1.33, (0, 0, 1))
        minus = stokes_point(500_000, 2.104, 1.33, (0, 0, -1))
        normal = stokes_point(500_000, 2.104, 1.33, (0, 1, 0))
        unpolarized = stokes_point(500_000, 2.104, 1.33, (0, 0, 0))
        half = stokes_point(500_000, 2.104, 1.33, (0, 0, 0.5))
        self.assertAlmostEqual(plus.electron_beta, 0.8628619619, places=9)
        self.assertAlmostEqual(math.degrees(plus.cherenkov_angle_rad), 29.38064557, places=7)
        self.assertAlmostEqual(plus.circular_stokes, 3.2077938e-6, delta=1e-10)
        self.assertAlmostEqual(plus.linear_stokes, 1, delta=1e-10)
        self.assertAlmostEqual(minus.circular_stokes, -plus.circular_stokes, delta=1e-12)
        self.assertAlmostEqual(normal.circular_stokes, 0, delta=1e-12)
        self.assertAlmostEqual(unpolarized.circular_stokes, 0, delta=1e-12)
        self.assertAlmostEqual(half.circular_stokes, plus.circular_stokes / 2, delta=1e-12)

    def test_one_mev_value_and_statistical_scaling(self):
        one_mev = stokes_point(1_000_000, 2.104, 1.33)
        self.assertAlmostEqual(one_mev.circular_stokes, 1.96792e-6, delta=1e-9)
        asymmetry = 0.8 * stokes_point(500_000, 2.104, 1.33).circular_stokes
        photons = ideal_detected_photons_for_significance(asymmetry, 5)
        self.assertAlmostEqual(photons, 3.796183065e12, delta=1e6)
        self.assertAlmostEqual(ideal_detected_photons_for_significance(asymmetry, 10),
                               4 * photons, delta=1e6)

    def test_thin_track_generated_photon_scale(self):
        beta = stokes_point(500_000, 2.104, 1.33).electron_beta
        yield_per_electron = ideal_band_photons_per_electron(beta, 1.33, 2.104,
                                                             10, 10e-6, 10)
        self.assertAlmostEqual(yield_per_electron, 8.828902803e-5, delta=1e-13)
        self.assertEqual(ideal_band_photons_per_electron(beta, 1.1, 2.104,
                                                          10, 10e-6), 0)


if __name__ == "__main__":
    unittest.main()
