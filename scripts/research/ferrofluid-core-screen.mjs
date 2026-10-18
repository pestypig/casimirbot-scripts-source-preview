// Read-only, catalog-prior screen for an untethered ferrofluid core.
// It does not predict levitation, ferrofluid retention, or a solar-field match.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const sourcePath = process.argv[2];
if (!sourcePath) {
  throw new Error("usage: node scripts/research/ferrofluid-core-screen.mjs <manifest.json>");
}
const bytes = readFileSync(sourcePath);
const input = JSON.parse(bytes.toString("utf8"));
const requirePositive = (value, name) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
  return value;
};
const bathDensity = requirePositive(input.bathDensityGPerMl, "bathDensityGPerMl");
const fluidDensity = requirePositive(input.ferrofluidDensityGPerMl, "ferrofluidDensityGPerMl");
const radiusM = requirePositive(input.exteriorProbeRadiusMm, "exteriorProbeRadiusMm") / 1000;
const doses = input.attachedFerrofluidMl;
if (!Array.isArray(doses) || doses.some((dose) => !Number.isFinite(dose) || dose < 0)) {
  throw new Error("attachedFerrofluidMl must be an array of nonnegative finite numbers");
}
const mu0 = 4 * Math.PI * 1e-7;
const gravity = 9.80665;
const round = (value, digits = 5) => Number(value.toFixed(digits));
const carrierMassG = input.carrierMassG ?? 0;
const carrierDisplacedVolumeMl = input.carrierDisplacedVolumeMl ?? 0;
if (![carrierMassG, carrierDisplacedVolumeMl].every((value) => Number.isFinite(value) && value >= 0)) {
  throw new Error("carrier mass and displaced volume must be nonnegative finite numbers");
}
const carrierApparentMassG = carrierMassG - bathDensity * carrierDisplacedVolumeMl;
const candidates = input.candidates.map((candidate) => {
  const diameterMm = requirePositive(candidate.diameterMm, `${candidate.id}.diameterMm`);
  const massG = requirePositive(candidate.catalogMassG, `${candidate.id}.catalogMassG`);
  const brT = requirePositive(candidate.brT, `${candidate.id}.brT`);
  const volumeMl = Math.PI * diameterMm ** 3 / 6000;
  const momentAm2 = brT * volumeMl * 1e-6 / mu0;
  const bareApparentMassG = massG - bathDensity * volumeMl;
  const idealGradientTPerM = bareApparentMassG * 1e-3 * gravity / momentAm2;
  const axialFieldMT = 1e3 * mu0 * 2 * momentAm2 / (4 * Math.PI * radiusM ** 3);
  const contrast = fluidDensity - bathDensity;
  const assemblyApparentMassG = bareApparentMassG + carrierApparentMassG;
  return {
    id: candidate.id,
    catalogUrl: candidate.catalogUrl,
    catalogListedUsd: candidate.catalogListedUsd,
    sphereVolumeMl: round(volumeMl, 6),
    idealDipoleMomentAm2: round(momentAm2, 6),
    bareApparentMassG: round(bareApparentMassG, 6),
    bareApparentWeightMN: round(bareApparentMassG * gravity, 5),
    carrierApparentMassG: round(carrierApparentMassG, 6),
    idealBareGradientTPerM: round(idealGradientTPerM, 5),
    idealAxialFieldMTAtProbeRadius: round(axialFieldMT, 5),
    neutralAttachedVolumeMl: contrast < 0 && assemblyApparentMassG > 0 ? round(-assemblyApparentMassG / contrast, 4) : null,
    doseScreen: doses.map((doseMl) => {
      const apparentMassG = assemblyApparentMassG + contrast * doseMl;
      return {
        attachedFerrofluidMl: doseMl,
        apparentMassG: round(apparentMassG, 5),
        apparentWeightMN: round(apparentMassG * gravity, 4),
        overheadAttractiveLiftDirection: apparentMassG > 0 ? "upward_force_needed" : "not_upward_force_needed",
      };
    }),
  };
});
const output = {
  formulaVersion: "ferrofluid-core-catalog-screen/1",
  inputSha256: createHash("sha256").update(bytes).digest("hex"),
  status: "catalog_priors_only_not_levitation_or_solar_evidence",
  assumptions: [
    "single solid sphere uniformly magnetized along one diameter",
    "point dipole used only for exterior radius and bare force gradient",
    "attached ferrofluid occupies volume disjoint from the magnet and moves with it",
    "optional carrier mass/displacement enters buoyancy only; ferrofluid magnetic force, coil field, walls, and feedback are excluded",
    "catalog remanence and fluid density must be replaced by measured values when available",
  ],
  exteriorProbeRadiusMm: input.exteriorProbeRadiusMm,
  candidates,
  missingEvidenceForLiftPurchase: [
    "measured inner neck and coil-face-to-core-center gap",
    "measured fluid lots, density, attached fraction and assembly displacement",
    "coil force versus actual gap/current for loaded core",
    "lateral and attitude stability, loss-of-power containment and heat margin",
  ],
  missingEvidenceForSolarClaim: [
    "admitted exact Star Watcher bundle/target and fixed laboratory transform",
    "registered, calibrated exterior three-axis field on training and held-out sites",
    "controlled target change across at least two source-linked target states",
  ],
};
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
