import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  PAPER_CANONICAL_RULES,
  PAPER_CANONICAL_TREE_FILES,
} from "./paper-framework-binding.js";

type CliOptions = {
  title: string;
  paperId?: string;
  tags: string[];
  focus?: string;
  outDir: string;
  attachmentNames: string[];
  sourceType: "pdf" | "image" | "mixed";
};

type CanonicalTreeNode = {
  id?: string;
  title?: string;
  summary?: string;
  evidence?: unknown;
};

type CanonicalTreeDoc = {
  nodes?: CanonicalTreeNode[];
};

type GraphResolverTree = {
  id?: string;
  path?: string;
  label?: string;
  matchers?: unknown;
  topicTags?: unknown;
};

type GraphResolverConfig = {
  trees?: GraphResolverTree[];
};

type PromptCanonicalTarget = {
  canonical_id: string;
  label: string;
  source_tree: string;
  relation: string;
  target_types: string[];
  keywords: string[];
  evidence_paths: string[];
};

type PromptExecutableHotspot = {
  canonical_id: string;
  file_path: string;
  symbols: string[];
  notes: string;
};

const DEFAULT_OUT_DIR = "artifacts/papers/gpt-pro";
const DEFAULT_SOURCE_TYPE: CliOptions["sourceType"] = "mixed";
const GPT_SCHEMA_PATH = "schemas/paper-gpt-pro-report.schema.json";
const GRAPH_RESOLVERS_PATH = "configs/graph-resolvers.json";

const RELEVANT_GRAPH_TREE_IDS = new Set([
  "stellar-ps1-bridges",
  "astrochemistry-prebiotic-neuro-consciousness-bridges",
  "dp-collapse",
  "uncertainty-mechanics",
  "warp-mechanics",
  "physics-gravitational-response",
  "physics_self_gravity_shape",
  "physics_stellar_structure_nucleosynthesis",
  "microphysics_hamiltonian_transport",
  "physics_quantum_semiclassical",
  "math",
  "paper-ingestion-runtime",
]);

const EXECUTABLE_HOTSPOTS: PromptExecutableHotspot[] = [
  {
    canonical_id: "dp-collapse-estimator",
    file_path: "shared/dp-collapse.ts",
    symbols: ["computeDpCollapse", "dpDeltaEPointPairPlummer", "dpSelfEnergyUniformSphere"],
    notes: "Primary DP collapse equations and collapse-time estimator.",
  },
  {
    canonical_id: "dp-collapse-derivation",
    file_path: "docs/DP_COLLAPSE_DERIVATION.md",
    symbols: ["DP collapse derivation"],
    notes: "Theory assumptions that define estimator interpretation.",
  },
  {
    canonical_id: "stress-energy-equations",
    file_path: "modules/dynamic/stress-energy-equations.ts",
    symbols: ["casimirEnergyDensity", "enhancedAvgEnergyDensity", "stressEnergyFromDensity"],
    notes: "Stress-energy math and coherence-linked energy density adapters.",
  },
  {
    canonical_id: "uncertainty-mechanics-data-contract-definition",
    file_path: "shared/physics.ts",
    symbols: ["Uncertainty1D", "Vec3Uncertainty"],
    notes: "Shared uncertainty payload contracts for sigma containers and deterministic band-carrying values.",
  },
  {
    canonical_id: "uncertainty-collapse-constraints",
    file_path: "shared/collapse-benchmark.ts",
    symbols: ["estimateTauRcFromCurvature", "collapseBenchmarkDiagnostics"],
    notes: "Collapse constraints, tau/r_c heuristics, and benchmark diagnostics.",
  },
  {
    canonical_id: "uncertainty-coherence-window",
    file_path: "server/services/collapse-benchmark.ts",
    symbols: ["resolveCollapseParams", "buildCollapseBenchmarkResult"],
    notes: "Server assembly for collapse benchmark records and observables.",
  },
  {
    canonical_id: "uncertainty-reality-bounds",
    file_path: "docs/knowledge/physics/energy-conditions.md",
    symbols: ["Energy Conditions"],
    notes: "Definition-level guardrail anchor for energy conditions, quantum-inequality posture, and sampling-window limits.",
  },
  {
    canonical_id: "bridge-noise-spectrum-to-collapse-proxy",
    file_path: "server/services/mixer/collapse.ts",
    symbols: ["collapseMix", "getCollapseStrategy"],
    notes: "Modal collapse proxy fusion and provenance tier handling.",
  },
  {
    canonical_id: "dp-adapters",
    file_path: "server/services/dp-adapters.ts",
    symbols: ["buildDpInputFromAdapter", "dpMassDistributionFromStressEnergyBrick"],
    notes: "Adapter bridge from stress-energy to DP inputs.",
  },
  {
    canonical_id: "dp-adapter-build",
    file_path: "server/services/dp-adapter-build.ts",
    symbols: ["buildDpAdapterFromSources"],
    notes: "Builds deterministic adapter payloads for DP planner and benchmark lanes.",
  },
  {
    canonical_id: "dp-planner-service",
    file_path: "server/services/dp-planner.ts",
    symbols: ["buildDpPlanResult"],
    notes: "Planner-level orchestration for DP collapse and emitted planning artifacts.",
  },
  {
    canonical_id: "halobank-solar-reference-frame",
    file_path: "server/modules/halobank-solar/types.ts",
    symbols: ["SolarFrame", "SolarReferenceContext"],
    notes: "Explicit frame semantics and target-minus-reference contract for solar vectors.",
  },
  {
    canonical_id: "halobank-solar-time-scale",
    file_path: "server/modules/halobank-solar/time-core.ts",
    symbols: ["computeSolarTimeScales"],
    notes: "Deterministic UTC/TAI/TT/TDB/TCB/TCG conversion layer used by solar routes and proofs.",
  },
  {
    canonical_id: "halobank-solar-metric-context",
    file_path: "server/modules/halobank-solar/types.ts",
    symbols: ["SolarMetricContextManifest", "SolarMetricContext"],
    notes: "Pinned weak-field BCRS/GCRS metric contract with explicit PN/GR model and source potentials.",
  },
  {
    canonical_id: "halobank-solar-observer-context",
    file_path: "server/modules/halobank-solar/derived.ts",
    symbols: ["normalizeSolarObserver", "resolveNullProbeObserver"],
    notes: "Observer-state normalization and deterministic body-fixed fallback semantics for derived solar modules.",
  },
  {
    canonical_id: "halobank-solar-signal-path",
    file_path: "server/modules/halobank-solar/derived.ts",
    symbols: ["runSolarLightDeflection", "apparentSeparationAndRadiiDeg"],
    notes: "Null-geodesic and apparent-geometry signal-path evaluation for deflection, eclipse, and Jovian event lanes.",
  },
  {
    canonical_id: "claim:halobank.solar:granular_tidal_response_diagnostic",
    file_path: "server/modules/halobank-solar/derived.ts",
    symbols: ["runGranularTidalResponseDiagnostic"],
    notes: "Executable diagnostic bridge from granular dissipation and effective rheology to tidal lag, spin evolution, and angular-momentum redistribution.",
  },
  {
    canonical_id: "claim:halobank.solar:stellar_flare_sunquake_diagnostic",
    file_path: "server/modules/halobank-solar/derived.ts",
    symbols: ["runStellarFlareSunquakeDiagnostic", "buildSunquakeReplayMetrics"],
    notes: "Executable diagnostic bridge from flare-energy and helioseismic observables to flare-to-sunquake timing coupling under explicit non-consciousness guardrails.",
  },
  {
    canonical_id: "claim:halobank.solar:sunquake_timing_replay_diagnostic",
    file_path: "server/modules/halobank-solar/derived.ts",
    symbols: ["runSunquakeTimingReplayDiagnostic", "buildSunquakeReplayMetrics"],
    notes: "Deterministic replay lane for sourced flare-to-sunquake timing windows and timing-envelope failures.",
  },
  {
    canonical_id: "physics-foundations-metric-definition",
    file_path: "docs/knowledge/physics/spacetime-metric-basics.md",
    symbols: ["Spacetime Metric Basics"],
    notes: "Definition-level metric anchor for interval, signature, and chart semantics.",
  },
  {
    canonical_id: "physics-foundations-field-equation-definition",
    file_path: "docs/knowledge/physics/einstein-field-equations.md",
    symbols: ["Einstein Field Equations"],
    notes: "Definition-level bridge from geometry to sourced dynamics.",
  },
  {
    canonical_id: "physics-foundations-stress-energy-definition",
    file_path: "docs/knowledge/physics/stress-energy-tensor.md",
    symbols: ["Stress-Energy Tensor"],
    notes: "Definition-level source term anchor for matter/energy coupling into curvature.",
  },
  {
    canonical_id: "physics-foundations-units-definition",
    file_path: "shared/gr-units.ts",
    symbols: ["gr-units"],
    notes: "Definition-level unit and scaling anchor for SI/geometric conversions.",
  },
  {
    canonical_id: "physics-foundations-viability-definition",
    file_path: "docs/knowledge/physics/viability-definition.md",
    symbols: ["Viability Definition"],
    notes: "Definition-level claim posture and evidence gate anchor.",
  },
  {
    canonical_id: "physics-thermodynamics-many-body-hamiltonian-definition",
    file_path: "docs/knowledge/physics/many-body-statistical-mechanics.md",
    symbols: ["Many Body Statistical Mechanics"],
    notes: "Definition-level anchor for the many-body Hamiltonian and partition-function backbone used by paper congruence.",
  },
  {
    canonical_id: "physics-thermodynamics-intermolecular-potential-definition",
    file_path: "docs/knowledge/physics/intermolecular-potentials.md",
    symbols: ["Intermolecular Potentials"],
    notes: "Definition-level anchor for Born-Oppenheimer potential surfaces and effective intermolecular potentials u(r).",
  },
  {
    canonical_id: "physics-thermodynamics-structure-response-definition",
    file_path: "docs/knowledge/physics/pair-correlation-structure-factor.md",
    symbols: ["Pair Correlation and Structure Factor"],
    notes: "Definition-level anchor for g(r), S(k), compressibility, and static density response.",
  },
  {
    canonical_id: "physics-thermodynamics-virial-equation-of-state-definition",
    file_path: "docs/knowledge/physics/virial-equation-of-state.md",
    symbols: ["Virial Equation of State"],
    notes: "Definition-level anchor for virial coefficients, compressibility factor Z, and Mayer f-function bindings.",
  },
  {
    canonical_id: "physics-thermodynamics-classical-density-functional-response-definition",
    file_path: "docs/knowledge/physics/classical-density-functional-theory.md",
    symbols: ["Classical Density Functional Theory"],
    notes: "Definition-level anchor for delta F/delta n + U_ext = mu and equilibrium response in external fields.",
  },
  {
    canonical_id: "physics-thermodynamics-equilibrium-tide-definition",
    file_path: "docs/knowledge/physics/equilibrium-tide.md",
    symbols: ["Equilibrium Tide"],
    notes: "Definition-level anchor for the hydrostatic tidal-potential limit and equipotential free-surface semantics.",
  },
  {
    canonical_id: "physics-thermodynamics-optical-trapping-definition",
    file_path: "docs/knowledge/physics/optical-trapping.md",
    symbols: ["Optical Trapping"],
    notes: "Definition-level anchor for optical potentials, dipole trapping, and Boltzmann redistribution in traps.",
  },
  {
    canonical_id: "physics-gravitational-response-lunisolar-tide-potential-definition",
    file_path: "docs/knowledge/physics/lunisolar-tide-generating-potential.md",
    symbols: ["Lunisolar Tide-Generating Potential"],
    notes: "Definition-level anchor for Moon/Sun differential forcing, tractive forces, and tide-generating potential semantics.",
  },
  {
    canonical_id: "physics-gravitational-response-tidal-tensor-definition",
    file_path: "docs/knowledge/physics/physics-gravitational-response-tree.json",
    symbols: ["physics-gravitational-response-tidal-tensor-definition"],
    notes: "Definition-level bridge from weak-field gravity gradients into differential forcing and material response.",
  },
  {
    canonical_id: "physics-gravitational-response-love-number-definition",
    file_path: "docs/knowledge/physics/tidal-bulge-response.md",
    symbols: ["Love Number"],
    notes: "Definition-level anchor for dimensionless tidal-response gain and deformability closure.",
  },
  {
    canonical_id: "physics-gravitational-response-dynamic-tide-definition",
    file_path: "docs/knowledge/physics/dynamic-tide.md",
    symbols: ["Dynamic Tide"],
    notes: "Definition-level anchor for the real forced-dissipative ocean-tide problem, distinct from equilibrium tide.",
  },
  {
    canonical_id: "physics-gravitational-response-equatorial-bulge-torque-definition",
    file_path: "docs/knowledge/physics/equatorial-bulge-torque.md",
    symbols: ["Equatorial Bulge Torque"],
    notes: "Definition-level bridge from Moon/Sun forcing to Earth's orientation torque response.",
  },
  {
    canonical_id: "physics-gravitational-response-dynamical-ellipticity-definition",
    file_path: "docs/knowledge/physics/earth-axial-precession.md",
    symbols: ["Dynamical Ellipticity"],
    notes: "Definition-level anchor for the inertia asymmetry that couples oblateness to precession and nutation.",
  },
  {
    canonical_id: "physics-gravitational-response-precession-constant-definition",
    file_path: "docs/knowledge/physics/earth-axial-precession.md",
    symbols: ["Precession Constant"],
    notes: "Definition-level anchor for lunisolar torque translated into spin-axis precession-rate scaling.",
  },
  {
    canonical_id: "physics-gravitational-response-earth-axial-precession-definition",
    file_path: "docs/knowledge/physics/earth-axial-precession.md",
    symbols: ["Earth Axial Precession"],
    notes: "Definition-level anchor for precession of the equinoxes and spin-axis conical motion.",
  },
  {
    canonical_id: "physics-gravitational-response-earth-nutation-definition",
    file_path: "docs/knowledge/physics/earth-nutation.md",
    symbols: ["Earth Nutation"],
    notes: "Definition-level anchor for the shorter-period modulation of Earth's spin-axis motion.",
  },
  {
    canonical_id: "physics-self-gravity-shape-self-gravity-definition",
    file_path: "docs/knowledge/physics/self-gravity.md",
    symbols: ["Self Gravity"],
    notes: "Definition-level load-term anchor for a body's own self-attraction in the shape lane.",
  },
  {
    canonical_id: "physics-self-gravity-shape-constitutive-response-definition",
    file_path: "docs/knowledge/physics/self-gravity-shape.md",
    symbols: ["Constitutive Response"],
    notes: "Definition-level anchor for the material closure that turns gravity loading into deformation and strength response.",
  },
  {
    canonical_id: "physics-self-gravity-shape-hydrostatic-equilibrium-shape-definition",
    file_path: "docs/knowledge/physics/hydrostatic-equilibrium-shape.md",
    symbols: ["Hydrostatic Equilibrium Shape"],
    notes: "Definition-level anchor for rounded hydrostatic figures in self-gravitating bodies.",
  },
  {
    canonical_id: "physics-self-gravity-shape-rotational-flattening-definition",
    file_path: "docs/knowledge/physics/rotational-flattening.md",
    symbols: ["Rotational Flattening"],
    notes: "Definition-level anchor for rotation-driven oblateness and flattening response.",
  },
  {
    canonical_id: "physics-self-gravity-shape-J2-definition",
    file_path: "docs/knowledge/physics/rotational-flattening.md",
    symbols: ["J2"],
    notes: "Definition-level anchor for the quadrupole gravity coefficient linking oblateness to orientation response.",
  },
  {
    canonical_id: "physics-self-gravity-shape-planetary-figure-diagnostic",
    file_path: "docs/knowledge/physics/planetary-figure-diagnostic.md",
    symbols: ["Planetary Figure Diagnostic"],
    notes: "Diagnostic anchor for low-order Earth-like figure closure over q, J2, H, k2, and flattening.",
  },
  {
    canonical_id: "physics-self-gravity-shape-granular-collision-dissipation-definition",
    file_path: "docs/knowledge/physics/granular-collision-dissipation.md",
    symbols: ["Granular Collision Dissipation"],
    notes: "Definition-level anchor for multiparticle collision, friction, and rearrangement losses in rubble-pile bodies.",
  },
  {
    canonical_id: "physics-self-gravity-shape-porous-rubble-pile-rheology-definition",
    file_path: "docs/knowledge/physics/porous-rubble-pile-rheology.md",
    symbols: ["Porous Rubble Pile Rheology"],
    notes: "Definition-level anchor for effective bulk rheology in self-gravitating granular aggregates.",
  },
  {
    canonical_id: "physics-self-gravity-shape-tidal-quality-factor-definition",
    file_path: "docs/knowledge/physics/tidal-quality-factor.md",
    symbols: ["Tidal Quality Factor"],
    notes: "Definition-level anchor for dissipation, phase lag, and k2 over Q style tidal-response closure.",
  },
  {
    canonical_id: "physics-self-gravity-shape-spin-state-evolution-definition",
    file_path: "docs/knowledge/physics/spin-state-evolution.md",
    symbols: ["Spin State Evolution"],
    notes: "Definition-level anchor for torque-driven spin evolution in granular and deformable bodies.",
  },
  {
    canonical_id: "physics-self-gravity-shape-angular-momentum-redistribution-definition",
    file_path: "docs/knowledge/physics/angular-momentum-redistribution.md",
    symbols: ["Angular Momentum Redistribution"],
    notes: "Definition-level anchor for spin-orbit angular-momentum exchange and internal redistribution in tidal response lanes.",
  },
  {
    canonical_id: "physics-self-gravity-shape-potato-radius-transition-definition",
    file_path: "docs/knowledge/physics/potato-radius-transition.md",
    symbols: ["Potato Radius Transition"],
    notes: "Definition-level anchor for the threshold where self-gravity overcomes material strength.",
  },
  {
    canonical_id: "physics-stellar-structure-nucleosynthesis-stellar-hydrostatic-equilibrium-definition",
    file_path: "docs/knowledge/physics/stellar-hydrostatic-equilibrium.md",
    symbols: ["Stellar Hydrostatic Equilibrium"],
    notes: "Definition-level anchor for stellar pressure support against self-gravity.",
  },
  {
    canonical_id: "physics-stellar-structure-nucleosynthesis-stellar-equation-of-state-definition",
    file_path: "docs/knowledge/physics/stellar-equation-of-state.md",
    symbols: ["Stellar Equation of State"],
    notes: "Definition-level anchor for stellar plasma EOS and density-pressure-temperature-composition coupling.",
  },
  {
    canonical_id: "physics-stellar-structure-nucleosynthesis-nuclear-reaction-rate-definition",
    file_path: "docs/knowledge/physics/nuclear-reaction-rate.md",
    symbols: ["Nuclear Reaction Rate"],
    notes: "Definition-level anchor for temperature-, density-, and composition-dependent stellar reaction rates.",
  },
  {
    canonical_id: "physics-stellar-structure-nucleosynthesis-stellar-nucleosynthesis-definition",
    file_path: "docs/knowledge/physics/stellar-nucleosynthesis.md",
    symbols: ["Stellar Nucleosynthesis"],
    notes: "Definition-level anchor for staged element creation inside stars.",
  },
  {
    canonical_id: "physics-stellar-structure-nucleosynthesis-stellar-oscillation-definition",
    file_path: "docs/knowledge/physics/stellar-structure-nucleosynthesis.md",
    symbols: ["Stellar Oscillation"],
    notes: "Diagnostic anchor for p-mode and g-mode stellar variability used as an observable lane, not a consciousness lane.",
  },
  {
    canonical_id: "physics-stellar-structure-nucleosynthesis-helioseismology-definition",
    file_path: "docs/knowledge/physics/stellar-structure-nucleosynthesis.md",
    symbols: ["Helioseismology"],
    notes: "Diagnostic anchor for inferring solar interior structure from oscillation spectra.",
  },
  {
    canonical_id: "physics-stellar-structure-nucleosynthesis-solar-dynamo-definition",
    file_path: "docs/knowledge/physics/stellar-structure-nucleosynthesis.md",
    symbols: ["Solar Dynamo"],
    notes: "Diagnostic anchor for rotation-convection driven magnetic-field generation in the Sun.",
  },
  {
    canonical_id: "physics-stellar-structure-nucleosynthesis-magnetic-cycle-definition",
    file_path: "docs/knowledge/physics/stellar-structure-nucleosynthesis.md",
    symbols: ["Magnetic Cycle"],
    notes: "Diagnostic anchor for large-scale activity-cycle modulation downstream of dynamo action.",
  },
  {
    canonical_id: "physics-stellar-structure-nucleosynthesis-magnetic-reconnection-definition",
    file_path: "docs/knowledge/physics/stellar-structure-nucleosynthesis.md",
    symbols: ["Magnetic Reconnection"],
    notes: "Diagnostic anchor for impulsive magnetic free-energy release in stellar atmospheres.",
  },
  {
    canonical_id: "physics-stellar-structure-nucleosynthesis-flare-avalanche-definition",
    file_path: "docs/knowledge/physics/stellar-structure-nucleosynthesis.md",
    symbols: ["Flare Avalanche"],
    notes: "Diagnostic anchor for SOC-style flare statistics and cascade interpretations in driven magnetic systems.",
  },
  {
    canonical_id: "physics-stellar-structure-nucleosynthesis-multiscale-plasma-variability-definition",
    file_path: "docs/knowledge/physics/stellar-structure-nucleosynthesis.md",
    symbols: ["Multiscale Plasma Variability"],
    notes: "Diagnostic anchor for the coupled oscillation-dynamo-reconnection activity stack across stellar timescales.",
  },
  {
    canonical_id: "physics-stellar-structure-nucleosynthesis-stellar-observables-diagnostic",
    file_path: "docs/knowledge/physics/stellar-observables-diagnostic.md",
    symbols: ["Stellar Observables Diagnostic"],
    notes: "Diagnostic anchor for magnetic-activity and helioseismic-shift coupling with optional flare-statistics support.",
  },
  {
    canonical_id: "physics-stellar-structure-nucleosynthesis-granulation-driven-pmode-pumping-definition",
    file_path: "docs/knowledge/physics/granulation-driven-pmode-pumping.md",
    symbols: ["Granulation Driven Pmode Pumping"],
    notes: "Diagnostic anchor for granulation and convection as the excitation source for the five-minute p-mode band.",
  },
  {
    canonical_id: "physics-stellar-structure-nucleosynthesis-nanoflare-heating-definition",
    file_path: "docs/knowledge/physics/nanoflare-heating.md",
    symbols: ["Nanoflare Heating"],
    notes: "Diagnostic anchor for impulsive small-scale magnetic heating in the coronal energy-release lane.",
  },
  {
    canonical_id: "physics-stellar-structure-nucleosynthesis-flare-particle-precipitation-definition",
    file_path: "docs/knowledge/physics/flare-particle-precipitation.md",
    symbols: ["Flare Particle Precipitation"],
    notes: "Diagnostic anchor for flare-driven particle precipitation and chromospheric energy deposition.",
  },
  {
    canonical_id: "physics-stellar-structure-nucleosynthesis-sunquake-definition",
    file_path: "docs/knowledge/physics/sunquake.md",
    symbols: ["Sunquake"],
    notes: "Diagnostic anchor for flare-driven helioseismic transients and seismic response at the solar surface.",
  },
  {
    canonical_id: "physics-stellar-structure-nucleosynthesis-flare-sunquake-timing-correlation-definition",
    file_path: "docs/knowledge/physics/flare-sunquake-timing-correlation.md",
    symbols: ["Flare Sunquake Timing Correlation"],
    notes: "Diagnostic anchor for replayable timing alignment between flare onset and sunquake response.",
  },
  {
    canonical_id: "physics-stellar-structure-nucleosynthesis-quasi-periodic-flare-envelope-definition",
    file_path: "docs/knowledge/physics/quasi-periodic-flare-envelope.md",
    symbols: ["Quasi Periodic Flare Envelope"],
    notes: "Diagnostic anchor for quasi-periodic pulsations and burst-envelope structure in flare observables.",
  },
  {
    canonical_id: "physics-stellar-structure-nucleosynthesis-magnetic-striation-hierarchy-definition",
    file_path: "docs/knowledge/physics/magnetic-striation-hierarchy.md",
    symbols: ["Magnetic Striation Hierarchy"],
    notes: "Diagnostic anchor for multiscale magnetic-striation morphology as weak observational context only.",
  },
  {
    canonical_id: "stellar-carbon-synthesis",
    file_path: "docs/knowledge/physics/stellar-carbon-synthesis.md",
    symbols: ["Stellar Carbon Synthesis"],
    notes: "Diagnostic anchor for stellar carbon production that seeds later astrochemistry lanes.",
  },
  {
    canonical_id: "interstellar-aromatic-carbon-chemistry",
    file_path: "docs/knowledge/physics/interstellar-aromatic-carbon-chemistry.md",
    symbols: ["Interstellar Aromatic Carbon Chemistry"],
    notes: "Diagnostic anchor for aromatic carbon chemistry in interstellar and circumstellar environments.",
  },
  {
    canonical_id: "interstellar-pah-chemistry",
    file_path: "docs/knowledge/physics/interstellar-pah-chemistry.md",
    symbols: ["Interstellar PAH Chemistry"],
    notes: "Diagnostic anchor for PAH-family chemistry and aromatic infrared signatures in space.",
  },
  {
    canonical_id: "meteoritic-prebiotic-organic-delivery",
    file_path: "docs/knowledge/physics/meteoritic-prebiotic-organic-delivery.md",
    symbols: ["Meteoritic Prebiotic Organic Delivery"],
    notes: "Diagnostic anchor for delivered meteorite organics and prebiotic inventory contributions.",
  },
  {
    canonical_id: "terrestrial-catecholamine-biosynthesis",
    file_path: "docs/knowledge/physics/terrestrial-catecholamine-biosynthesis.md",
    symbols: ["Terrestrial Catecholamine Biosynthesis"],
    notes: "Diagnostic anchor for terrestrial biosynthesis of catecholamines including dopamine.",
  },
  {
    canonical_id: "dopamine-reward-signaling",
    file_path: "docs/knowledge/physics/dopamine-reward-signaling.md",
    symbols: ["Dopamine Reward Signaling"],
    notes: "Diagnostic anchor for reward-prediction and reinforcement semantics, distinct from teleological claims.",
  },
  {
    canonical_id: "quantum-consciousness-hypothesis",
    file_path: "docs/knowledge/physics/quantum-consciousness-hypothesis.md",
    symbols: ["Quantum Consciousness Hypothesis"],
    notes: "Exploratory anchor for generic quantum-consciousness proposals with hard maturity separation.",
  },
  {
    canonical_id: "orch-or-hypothesis",
    file_path: "docs/knowledge/physics/orch-or-hypothesis.md",
    symbols: ["Orch OR Hypothesis"],
    notes: "Exploratory anchor for the Penrose-Hameroff Orch-OR proposal, kept separate from stellar-coherence bridges.",
  },
  {
    canonical_id: "stellar-plasma-observables-not-consciousness",
    file_path: "docs/knowledge/bridges/astrochemistry-prebiotic-neuro-consciousness-bridge-tree.json",
    symbols: ["stellar-plasma-observables-not-consciousness"],
    notes: "Guardrail anchor that prevents stellar plasma observables from being upgraded into consciousness claims.",
  },
  {
    canonical_id: "sunquake_not_quantum_collapse",
    file_path: "docs/knowledge/bridges/astrochemistry-prebiotic-neuro-consciousness-bridge-tree.json",
    symbols: ["sunquake_not_quantum_collapse"],
    notes: "Guardrail anchor that prevents sunquake and flare-timing observables from being promoted into quantum-collapse or consciousness claims.",
  },
  {
    canonical_id: "physics-quantum-semiclassical-quantum-statistics-definition",
    file_path: "docs/knowledge/physics/quantum-statistics.md",
    symbols: ["Quantum Statistics"],
    notes: "Definition-level anchor for thermal de Broglie crossover, Bose/Fermi behavior, and quantum-liquid limits.",
  },
  {
    canonical_id: "physics-quantum-semiclassical-decoherence-classicality-definition",
    file_path: "docs/knowledge/physics/decoherence-classical-limit.md",
    symbols: ["Decoherence Classical Limit"],
    notes: "Definition-level anchor for environment-induced decoherence and classical bulk observables.",
  },
  {
    canonical_id: "physics-quantum-semiclassical-stochastic-open-quantum-dynamics-definition",
    file_path: "docs/knowledge/physics/physics-quantum-semiclassical-tree.json",
    symbols: ["physics-quantum-semiclassical-stochastic-open-quantum-dynamics-definition"],
    notes: "Exploratory anchor for stochastic open-system quantum evolution and collapse-model families.",
  },
  {
    canonical_id: "physics-quantum-semiclassical-stochastic-schrodinger-equation-definition",
    file_path: "docs/knowledge/physics/physics-quantum-semiclassical-tree.json",
    symbols: ["physics-quantum-semiclassical-stochastic-schrodinger-equation-definition"],
    notes: "Exploratory anchor for stochastic Schrodinger-equation model classes.",
  },
  {
    canonical_id: "physics-quantum-semiclassical-csl-definition",
    file_path: "docs/knowledge/physics/physics-quantum-semiclassical-tree.json",
    symbols: ["physics-quantum-semiclassical-csl-definition"],
    notes: "Exploratory anchor for continuous spontaneous localization and related collapse models.",
  },
  {
    canonical_id: "physics-quantum-semiclassical-colored-noise-collapse-hypothesis",
    file_path: "docs/knowledge/physics/physics-quantum-semiclassical-tree.json",
    symbols: ["physics-quantum-semiclassical-colored-noise-collapse-hypothesis"],
    notes: "Exploratory anchor for colored-noise collapse proposals with no certified consciousness bridge.",
  },
  {
    canonical_id: "alcubierre-metric",
    file_path: "docs/knowledge/warp/alcubierre-metric.md",
    symbols: ["Alcubierre Metric"],
    notes: "Definition-level anchor for the canonical Alcubierre warp metric family used for geometry comparison.",
  },
  {
    canonical_id: "natario-zero-expansion",
    file_path: "docs/knowledge/warp/natario-zero-expansion.md",
    symbols: ["Natario Zero-Expansion"],
    notes: "Definition-level anchor for Natario-family zero-expansion warp constructions and Needle Hull family placement.",
  },
  {
    canonical_id: "shift-vector-expansion-scalar",
    file_path: "docs/knowledge/warp/shift-vector-expansion-scalar.md",
    symbols: ["Shift Vector and Expansion Scalar"],
    notes: "Definition-level anchor for ADM shift-vector and expansion-scalar semantics used in warp geometry diagnostics.",
  },
  {
    canonical_id: "vdb-compression-factor",
    file_path: "docs/knowledge/warp/vdb-compression-factor.md",
    symbols: ["Van Den Broeck Compression Factor"],
    notes: "Definition-level anchor for Van Den Broeck family geometry-compression semantics and gamma_VdB parameterization.",
  },
  {
    canonical_id: "physics-self-gravity-shape-granular-collision-dissipation-definition",
    file_path: "docs/knowledge/physics/granular-collision-dissipation.md",
    symbols: ["Granular Collision Dissipation"],
    notes: "Definition-level anchor for inelastic contact loss and frictional rearrangement dissipation in rubble-pile bodies.",
  },
  {
    canonical_id: "physics-self-gravity-shape-porous-rubble-pile-rheology-definition",
    file_path: "docs/knowledge/physics/porous-rubble-pile-rheology.md",
    symbols: ["Porous Rubble-Pile Rheology"],
    notes: "Definition-level anchor for effective aggregate rheology in porous rubble-pile bodies.",
  },
  {
    canonical_id: "physics-self-gravity-shape-tidal-quality-factor-definition",
    file_path: "docs/knowledge/physics/tidal-quality-factor.md",
    symbols: ["Tidal Quality Factor"],
    notes: "Definition-level anchor for cycle-by-cycle tidal dissipation in rubble-pile bodies.",
  },
  {
    canonical_id: "physics-self-gravity-shape-spin-state-evolution-definition",
    file_path: "docs/knowledge/physics/spin-state-evolution.md",
    symbols: ["Spin-State Evolution"],
    notes: "Definition-level anchor for tidal torque and dissipation driven spin-rate and obliquity change.",
  },
  {
    canonical_id: "physics-self-gravity-shape-angular-momentum-redistribution-definition",
    file_path: "docs/knowledge/physics/angular-momentum-redistribution.md",
    symbols: ["Angular Momentum Redistribution"],
    notes: "Definition-level anchor for exchange among spin, orbit, and internal motion in granular bodies.",
  },
  {
    canonical_id: "physics-self-gravity-shape-granular-tidal-response-diagnostic",
    file_path: "docs/knowledge/physics/granular-tidal-response-diagnostic.md",
    symbols: ["Granular Tidal Response Diagnostic"],
    notes: "Derived diagnostic anchor for rubble-pile tidal damping and spin-state closure.",
  },
  {
    canonical_id: "physics-stellar-structure-nucleosynthesis-granulation-driven-pmode-pumping-definition",
    file_path: "docs/knowledge/physics/granulation-driven-pmode-pumping.md",
    symbols: ["Granulation-Driven P-Mode Pumping"],
    notes: "Definition-level anchor for granulation and convection injecting p-mode power.",
  },
  {
    canonical_id: "physics-stellar-structure-nucleosynthesis-nanoflare-heating-definition",
    file_path: "docs/knowledge/physics/nanoflare-heating.md",
    symbols: ["Nanoflare Heating"],
    notes: "Definition-level anchor for impulsive magnetic heating by many small reconnection events.",
  },
  {
    canonical_id: "physics-stellar-structure-nucleosynthesis-flare-particle-precipitation-definition",
    file_path: "docs/knowledge/physics/flare-particle-precipitation.md",
    symbols: ["Flare Particle Precipitation"],
    notes: "Definition-level anchor for flare-accelerated particles depositing energy in the lower atmosphere.",
  },
  {
    canonical_id: "physics-stellar-structure-nucleosynthesis-sunquake-definition",
    file_path: "docs/knowledge/physics/sunquake.md",
    symbols: ["Sunquake"],
    notes: "Definition-level anchor for flare-driven helioseismic surface response.",
  },
  {
    canonical_id: "physics-stellar-structure-nucleosynthesis-flare-sunquake-timing-correlation-definition",
    file_path: "docs/knowledge/physics/flare-sunquake-timing-correlation.md",
    symbols: ["Flare-Sunquake Timing Correlation"],
    notes: "Definition-level anchor for replayable flare-onset and sunquake timing correlation.",
  },
  {
    canonical_id: "physics-stellar-structure-nucleosynthesis-quasi-periodic-flare-envelope-definition",
    file_path: "docs/knowledge/physics/quasi-periodic-flare-envelope.md",
    symbols: ["Quasi-Periodic Flare Envelope"],
    notes: "Definition-level anchor for burst-envelope and quasi-periodic pulsation structure in flares.",
  },
  {
    canonical_id: "physics-stellar-structure-nucleosynthesis-magnetic-striation-hierarchy-definition",
    file_path: "docs/knowledge/physics/magnetic-striation-hierarchy.md",
    symbols: ["Magnetic Striation Hierarchy"],
    notes: "Definition-level anchor for fine magnetic striations as morphology context.",
  },
  {
    canonical_id: "physics-stellar-structure-nucleosynthesis-sunquake-timing-replay-diagnostic",
    file_path: "docs/knowledge/physics/sunquake-timing-replay-diagnostic.md",
    symbols: ["Sunquake Timing Replay Diagnostic"],
    notes: "Derived diagnostic anchor for replaying flare, granulation, and sunquake timing windows.",
  },
  {
    canonical_id: "microphysics-hamiltonian-transport-observables-plan",
    file_path: "docs/architecture/microphysics-hamiltonian-transport-observables-plan.md",
    symbols: ["Microphysics Hamiltonian Transport Observables Plan"],
    notes: "Architecture plan for the shared microphysics, Hamiltonian, transport, and observables backbone.",
  },
  {
    canonical_id: "sunquake_not_quantum_collapse",
    file_path: "docs/knowledge/bridges/astrochemistry-prebiotic-neuro-consciousness-bridge-tree.json",
    symbols: ["Sunquake Not Quantum Collapse"],
    notes: "Bridge guardrail that fences sunquake observables away from collapse or consciousness claims.",
  },
];

const INGEST_CONTRACT_FILES = [
  "scripts/paper-prompt-ingest.ts",
  "scripts/paper-framework-binding.ts",
  "docs/architecture/paper-ingestion-paperrun-contract-v1.md",
  "docs/runbooks/paper-prompt-ingest.md",
  "schemas/paper-ingest-request.schema.json",
  "schemas/paper-run-record.schema.json",
  "schemas/paper-knowledge-pack.schema.json",
  "docs/knowledge/paper-ingestion-runtime-tree.json",
  "docs/knowledge/physics/physics-microphysics-transport-tree.json",
  "docs/knowledge/physics/physics-thermodynamics-entropy-tree.json",
  "docs/knowledge/physics/physics-gravitational-response-tree.json",
  "docs/knowledge/physics/physics-self-gravity-shape-tree.json",
  "docs/knowledge/physics/physics-stellar-structure-nucleosynthesis-tree.json",
  "docs/knowledge/physics/physics-quantum-semiclassical-tree.json",
  "docs/knowledge/bridges/astrochemistry-prebiotic-neuro-consciousness-bridge-tree.json",
  "docs/knowledge/warp/warp-mechanics-tree.json",
  "docs/knowledge/halobank-solar-proof-tree.json",
  "docs/knowledge/math-claims/microphysics-transport.math-claims.json",
  "docs/knowledge/math-claims/gravitational-response.math-claims.json",
  "docs/knowledge/math-claims/self-gravity-shape.math-claims.json",
  "docs/knowledge/math-claims/stellar-structure-nucleosynthesis.math-claims.json",
  "docs/knowledge/math-claims/halobank-solar.math-claims.json",
  "docs/knowledge/math-claims/warp-metric-family.math-claims.json",
  "docs/audits/research/gravitational-response-tide-precession-bridge-2026-03-25.md",
  "docs/audits/research/gravitational-response-equation-wiring-2026-03-25.md",
  "docs/audits/research/self-gravity-shape-source-check-2026-03-25.md",
  "docs/audits/research/planetary-figure-diagnostic-source-check-2026-03-25.md",
  "docs/audits/research/stellar-structure-nucleosynthesis-source-check-2026-03-25.md",
  "docs/audits/research/stellar-observables-diagnostic-source-check-2026-03-25.md",
  "docs/audits/research/stellar-consciousness-ii-method-review-2026-03-25.md",
  "docs/audits/research/granular-tidal-sunquake-source-check-2026-03-25.md",
  "docs/architecture/microphysics-hamiltonian-transport-observables-plan.md",
  "docs/architecture/orch-or-time-crystal-research-packet.md",
  "docs/audits/research/astrochemistry-prebiotic-neuro-consciousness-source-catalog-2026-03-25.md",
  "docs/audits/research/gravitating-matter-astrochemistry-source-catalog-2026-03-25.md",
  "docs/audits/research/orch-or-time-crystal-source-packet-2026-03-25.md",
  "docs/audits/research/bandyopadhyay-triplet-hierarchy-triage-2026-03-25.md",
  "configs/halobank-solar-metric-context.v1.json",
  "configs/graph-resolvers.json",
  "configs/physics-root-leaf-manifest.v1.json",
];

function parseArgs(argv: string[]): CliOptions {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith("--")) continue;
    const key = raw.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args.set(key, "1");
      continue;
    }
    args.set(key, next);
    i += 1;
  }
  const title = (args.get("title") ?? "Attached Scientific Paper").trim();
  const sourceType = parseSourceType(args.get("source-type"));
  return {
    title,
    paperId: args.get("paper-id")?.trim(),
    tags: splitCsv(args.get("tags")),
    focus: args.get("focus")?.trim(),
    outDir: args.get("out-dir")?.trim() || DEFAULT_OUT_DIR,
    attachmentNames: splitCsv(args.get("attachment-names"), true),
    sourceType,
  };
}

function parseSourceType(input?: string): CliOptions["sourceType"] {
  const normalized = (input ?? "").trim().toLowerCase();
  if (normalized === "pdf") return "pdf";
  if (normalized === "image") return "image";
  return DEFAULT_SOURCE_TYPE;
}

function splitCsv(input?: string, preserveCase = false): string[] {
  if (!input) return [];
  const values = input
    .split(",")
    .map((entry) => (preserveCase ? entry.trim() : normalizeTag(entry)))
    .filter(Boolean);
  return Array.from(new Set(values));
}

function normalizeTag(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function toFsSafeName(value: string): string {
  return value.replace(/[:]+/g, "-").replace(/[^a-z0-9._-]+/gi, "-");
}

function safeArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function extractEvidencePaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const paths = value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const candidate = (entry as { path?: unknown }).path;
      return typeof candidate === "string" ? candidate.trim() : null;
    })
    .filter((entry): entry is string => Boolean(entry));
  return Array.from(new Set(paths));
}

async function readJsonFile<T>(relativePath: string): Promise<T | null> {
  const absolutePath = path.resolve(relativePath);
  try {
    const raw = await fs.readFile(absolutePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function loadCanonicalTargets(): Promise<PromptCanonicalTarget[]> {
  const nodeById = new Map<string, { label: string; sourceTree: string; evidencePaths: string[] }>();
  for (const treePath of PAPER_CANONICAL_TREE_FILES) {
    const doc = await readJsonFile<CanonicalTreeDoc>(treePath);
    if (!doc) continue;
    for (const node of doc.nodes ?? []) {
      const nodeId = typeof node.id === "string" ? node.id.trim() : "";
      if (!nodeId) continue;
      const label = typeof node.title === "string" && node.title.trim() ? node.title.trim() : nodeId;
      nodeById.set(nodeId, {
        label,
        sourceTree: treePath,
        evidencePaths: extractEvidencePaths(node.evidence),
      });
    }
  }

  const byCanonicalId = new Map<string, PromptCanonicalTarget>();
  for (const rule of PAPER_CANONICAL_RULES) {
    const existing = byCanonicalId.get(rule.canonicalId);
    const descriptor = nodeById.get(rule.canonicalId);
    const target: PromptCanonicalTarget = {
      canonical_id: rule.canonicalId,
      label: descriptor?.label ?? rule.canonicalId,
      source_tree: descriptor?.sourceTree ?? "unknown",
      relation: rule.relation,
      target_types: rule.targetTypes.slice(),
      keywords: rule.keywords.slice(),
      evidence_paths: descriptor?.evidencePaths ?? [],
    };
    if (!existing) {
      byCanonicalId.set(rule.canonicalId, target);
      continue;
    }
    existing.keywords = Array.from(new Set([...existing.keywords, ...target.keywords]));
    existing.target_types = Array.from(new Set([...existing.target_types, ...target.target_types]));
    if (existing.evidence_paths.length === 0 && target.evidence_paths.length > 0) {
      existing.evidence_paths = target.evidence_paths;
    }
    if (existing.source_tree === "unknown" && target.source_tree !== "unknown") {
      existing.source_tree = target.source_tree;
      existing.label = target.label;
    }
  }

  return Array.from(byCanonicalId.values()).sort((a, b) => a.canonical_id.localeCompare(b.canonical_id));
}

async function loadRelevantGraphLanes(): Promise<
  Array<{
    id: string;
    path: string;
    label: string;
    topic_tags: string[];
    matchers: string[];
  }>
> {
  const config = await readJsonFile<GraphResolverConfig>(GRAPH_RESOLVERS_PATH);
  if (!config?.trees) return [];
  const lanes = config.trees
    .map((entry) => ({
      id: typeof entry.id === "string" ? entry.id : "",
      path: typeof entry.path === "string" ? entry.path : "",
      label: typeof entry.label === "string" ? entry.label : "",
      topic_tags: safeArray(entry.topicTags),
      matchers: safeArray(entry.matchers),
    }))
    .filter((entry) => entry.id && entry.path);
  return lanes
    .filter(
      (entry) =>
        RELEVANT_GRAPH_TREE_IDS.has(entry.id) ||
        PAPER_CANONICAL_TREE_FILES.includes(entry.path as (typeof PAPER_CANONICAL_TREE_FILES)[number]),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function filterExistingPaths(paths: string[]): Promise<string[]> {
  const existing: string[] = [];
  for (const candidate of paths) {
    try {
      await fs.access(path.resolve(candidate));
      existing.push(candidate);
    } catch {
      // ignore
    }
  }
  return Array.from(new Set(existing));
}

function buildPromptMarkdown(input: {
  title: string;
  paperId: string;
  sourceType: CliOptions["sourceType"];
  tags: string[];
  focus?: string;
  attachmentNames: string[];
  canonicalTargets: PromptCanonicalTarget[];
  executableHotspots: PromptExecutableHotspot[];
  graphLanes: Array<{ id: string; path: string; label: string; topic_tags: string[]; matchers: string[] }>;
  ingestContractFiles: string[];
  contextPath: string;
  templatePath: string;
}): string {
  const attachmentList = input.attachmentNames.length > 0 ? input.attachmentNames : ["<attached-file>"];
  const tagLine = input.tags.length > 0 ? input.tags.join(", ") : "paper,physics";
  const focusLine = input.focus ? `Focus hints: ${input.focus}` : "Focus hints: extract all physically testable claims.";
  const canonicalLines = input.canonicalTargets
    .map(
      (entry) =>
        `- ${entry.canonical_id} (${entry.label}) :: relation=${entry.relation}; targets=${entry.target_types.join("/")}; source=${entry.source_tree}`,
    )
    .join("\n");
  const hotspotLines = input.executableHotspots
    .map(
      (entry) =>
        `- ${entry.canonical_id} -> ${entry.file_path} :: symbols=${entry.symbols.join(", ")} :: ${entry.notes}`,
    )
    .join("\n");
  const laneLines = input.graphLanes
    .map((entry) => `- ${entry.id} (${entry.label}) -> ${entry.path}`)
    .join("\n");
  const contractLines = input.ingestContractFiles.map((entry) => `- ${entry}`).join("\n");
  return [
    "You are producing a CasimirBot paper ingestion report for Codex implementation.",
    "",
    "Task",
    `- Analyze the attached paper source (${input.sourceType}) and produce a single JSON object that validates against \`${GPT_SCHEMA_PATH}\`.`,
    `- Paper ID: ${input.paperId}`,
    `- Title: ${input.title}`,
    `- Tags: ${tagLine}`,
    `- Attachments: ${attachmentList.join(", ")}`,
    `- ${focusLine}`,
    "",
    "Hard requirements",
    "- Return JSON only (no markdown, no prose around JSON).",
    "- Every claim must include at least one evidence span with page + direct quote from the paper.",
    "- Every citation must include evidence spans and raw citation text exactly as seen in the paper.",
    "- `canonical_bindings[].canonical_id` must be selected from the canonical target list below.",
    "- `executable_mappings[].implementation_candidates[].file_path` must reference a real repo path from the hotspot/contract files.",
    "- `derivation_lineage` must include ordered replay steps whose final output hash matches the lineage hash.",
    "- If evidence is missing, keep the item but mark low confidence and explain in rationale/notes (do not fabricate).",
    "",
    "Canonical targets",
    canonicalLines,
    "",
    "Executable hotspots",
    hotspotLines,
    "",
    "Graph resolver lanes to align with",
    laneLines || "- none",
    "",
    "Ingestion contract files",
    contractLines,
    "",
    "Reference artifacts generated in this repo",
    `- Context packet: ${input.contextPath}`,
    `- JSON template: ${input.templatePath}`,
    "",
    "Output schema path",
    `- ${GPT_SCHEMA_PATH}`,
  ].join("\n");
}

function buildTemplateJson(input: {
  title: string;
  sourceType: CliOptions["sourceType"];
  attachmentNames: string[];
  tags: string[];
  canonicalTargets: PromptCanonicalTarget[];
  executableHotspots: PromptExecutableHotspot[];
}): Record<string, unknown> {
  const firstCanonicalTarget = input.canonicalTargets[0];
  const firstCanonical = firstCanonicalTarget?.canonical_id ?? "dp-collapse-derivation";
  const firstHotspot = input.executableHotspots[0];
  const generatedAt = new Date().toISOString();
  const templateHash = "0000000000000000000000000000000000000000000000000000000000000000";
  return {
    schema_version: 1,
    report_id: `gptreport:${randomUUID()}`,
    generated_at: generatedAt,
    generator: {
      platform: "chatgpt",
      model: "gpt-pro",
      notes: "Replace placeholder values with extracted paper evidence.",
    },
    paper: {
      title: input.title,
      source_type: input.sourceType,
      attachment_names: input.attachmentNames.length > 0 ? input.attachmentNames : ["<attached-file>"],
      topic_tags: input.tags,
    },
    claims: [
      {
        claim_id: "claim:template:1",
        claim_type: "observation",
        text: "Replace with a paper-grounded claim.",
        confidence: 0.5,
        evidence_spans: [{ page: 1, quote: "Replace with exact quote.", locator: "section:1" }],
      },
    ],
    citations: [],
    citation_links: [],
    paper_card: {
      concepts: [],
      quantitative_values: [],
      systems: [],
      math_objects: {
        equations: [],
        definitions: [],
        variables: [],
        units: [],
        assumptions: [],
      },
      congruence_assessments: [],
    },
    canonical_bindings: [
      {
        local_id: "claim:template:1",
        local_type: "claim",
        canonical_id: firstCanonical,
        relation: "supports",
        score: 0.5,
        source_tree: firstCanonicalTarget?.source_tree ?? "docs/knowledge/dp-collapse-tree.json",
        rationale: "Replace with actual mapping rationale.",
      },
    ],
    executable_mappings: firstHotspot
      ? [
          {
            canonical_id: firstHotspot.canonical_id,
            model_kind: "model",
            implementation_candidates: [
              {
                file_path: firstHotspot.file_path,
                kind: "function",
                symbol: firstHotspot.symbols[0] ?? "computeDpCollapse",
                confidence: 0.5,
                rationale: "Replace with evidence-grounded implementation linkage.",
              },
            ],
          },
        ]
      : [],
    prediction_contract_candidates: [],
    symbol_equivalence_entries: [],
    derivation_lineage: {
      lineage_version: 1,
      lineage_hash: templateHash,
      replay_seed: "seed:template",
      steps: [
        {
          step_id: "step:template:ingest",
          version: 1,
          operation: "merge",
          at: generatedAt,
          input_hashes: [templateHash],
          output_hashes: [templateHash],
        },
      ],
    },
    maturity_gate_candidates: [],
    codex_patch_guidance: {
      target_files: [
        "scripts/paper-prompt-ingest.ts",
        "docs/knowledge/paper-ingestion-runtime-tree.json",
      ],
      merge_strategy: "merge_with_dedupe",
      notes: "Replace with precise merge actions grounded in extracted evidence.",
    },
  };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const title = opts.title;
  const paperId =
    opts.paperId && opts.paperId.length > 0
      ? opts.paperId
      : `${slugify(title) || "paper"}:${createHash("sha256").update(title).digest("hex").slice(0, 8)}`;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outRoot = path.resolve(opts.outDir, toFsSafeName(paperId));
  await fs.mkdir(outRoot, { recursive: true });

  const canonicalTargets = await loadCanonicalTargets();
  const graphLanes = await loadRelevantGraphLanes();
  const existingIngestFiles = await filterExistingPaths(INGEST_CONTRACT_FILES);
  const existingHotspots = (
    await Promise.all(
      EXECUTABLE_HOTSPOTS.map(async (entry) => {
        try {
          await fs.access(path.resolve(entry.file_path));
          return entry;
        } catch {
          return null;
        }
      }),
    )
  ).filter((entry): entry is PromptExecutableHotspot => entry !== null);

  const context = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    paper_id: paperId,
    paper_title: title,
    source_type: opts.sourceType,
    topic_tags: opts.tags,
    focus: opts.focus ?? null,
    output_schema: GPT_SCHEMA_PATH,
    graph_lanes: graphLanes,
    canonical_targets: canonicalTargets,
    executable_hotspots: existingHotspots,
    ingest_contract_files: existingIngestFiles,
  };

  const contextPath = path.join(outRoot, `${stamp}.context.json`);
  const templatePath = path.join(outRoot, `${stamp}.template.json`);
  const promptPath = path.join(outRoot, `${stamp}.prompt.md`);

  const templateJson = buildTemplateJson({
    title,
    sourceType: opts.sourceType,
    attachmentNames: opts.attachmentNames,
    tags: opts.tags,
    canonicalTargets,
    executableHotspots: existingHotspots,
  });
  const promptMd = buildPromptMarkdown({
    title,
    paperId,
    sourceType: opts.sourceType,
    tags: opts.tags,
    focus: opts.focus,
    attachmentNames: opts.attachmentNames,
    canonicalTargets,
    executableHotspots: existingHotspots,
    graphLanes,
    ingestContractFiles: existingIngestFiles,
    contextPath,
    templatePath,
  });

  await fs.writeFile(contextPath, `${JSON.stringify(context, null, 2)}\n`, "utf8");
  await fs.writeFile(templatePath, `${JSON.stringify(templateJson, null, 2)}\n`, "utf8");
  await fs.writeFile(promptPath, `${promptMd}\n`, "utf8");

  const summary = {
    ok: true,
    paperId,
    files: {
      prompt: promptPath,
      context: contextPath,
      template: templatePath,
    },
    counts: {
      canonicalTargets: canonicalTargets.length,
      executableHotspots: existingHotspots.length,
      graphLanes: graphLanes.length,
      ingestContractFiles: existingIngestFiles.length,
    },
    schema: GPT_SCHEMA_PATH,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[paper-gpt-pro-packet] ${message}`);
  process.exitCode = 1;
});
