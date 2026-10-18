import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  idealSuccessfulPairsForUncertainty,
  matchingOutcomeProbability,
  responseCoefficients,
  terrestrialClockSignal,
  YB171_CLOCK_FREQUENCY_HZ,
  STANDARD_GRAVITY_M_S2,
  LIGHT_SPEED_M_S,
} from "../../shared/theory/ytterbium-clock-proposal-calculation";

const rows = [0.01, 1, 10, 50, 100, 450].map((height) => terrestrialClockSignal(height));
const report = {
  schema: "ytterbium_clock_proposal_calculation/v1",
  status: "analytic_design_only",
  constants: {
    ytterbium171ClockFrequencyHz: YB171_CLOCK_FREQUENCY_HZ,
    standardGravityM_S2: STANDARD_GRAVITY_M_S2,
    lightSpeedM_S: LIGHT_SPEED_M_S,
  },
  model: "stationary_weak_field_constant_gravity",
  rows,
  oneCentimeterTenSecondPhaseRad: rows[0].phaseRateRadS * 10,
  oneCentimeterOnePercentFrequencyBiasHz: rows[0].frequencyDifferenceHz * 0.01,
  hundredMeterTenToMinusFourFrequencyBiasHz: rows[4].frequencyDifferenceHz * 1e-4,
  hundredMeterTenToMinusFourPhaseBiasRad: rows[4].phaseRateRadS * 1e-4,
  idealHalfRadianMatchingProbabilities: {
    plus: matchingOutcomeProbability(0.5, 1, 1, Math.PI / 2),
    minus: matchingOutcomeProbability(0.5, -1, 1, Math.PI / 2),
  },
  nullResponse: responseCoefficients(1, 1),
  idealSuccessfulPairsAt100M_1S_C08: {
    uncertainty1e3: idealSuccessfulPairsForUncertainty(100, 1, 0.8, 1e-3),
    uncertainty1e4: idealSuccessfulPairsForUncertainty(100, 1, 0.8, 1e-4),
    uncertainty1e5: idealSuccessfulPairsForUncertainty(100, 1, 0.8, 1e-5),
  },
  sources: [
    "https://www.bipm.org/documents/20126/288516347/171Yb_518THz_2025/73007ecc-49f5-4d1d-d8ee-6793a4748598",
    "https://chatgpt.com/share/6ab672dc-e820-83ea-a2a5-26643690422a",
  ],
  claimBoundary: "These are calculated design values, not measured performance or a test of new physics.",
};

const outputPath = resolve("docs/research/ytterbium-clock-proposal-calculations.json");
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(outputPath);
