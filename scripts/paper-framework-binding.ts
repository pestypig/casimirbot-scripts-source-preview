import fs from "node:fs/promises";
import path from "node:path";

export type CanonicalTargetType = "concept" | "system" | "equation" | "model";
export type CanonicalBindingRelation = "equivalent_to" | "refines" | "derives_from";
export type CanonicalDagNodeType = "entity" | "system" | "equation" | "model" | "theory" | "definition";

export type CanonicalBindingMatch = {
  canonicalId: string;
  canonicalLabel: string;
  targetType: CanonicalTargetType;
  relation: CanonicalBindingRelation;
  score: number;
  sourceTree: string;
  evidencePaths: string[];
  nodeType: CanonicalDagNodeType;
};

export type CanonicalBindingSet = {
  concept: Record<string, CanonicalBindingMatch>;
  system: Record<string, CanonicalBindingMatch>;
  equation: Record<string, CanonicalBindingMatch>;
  model: CanonicalBindingMatch | null;
};

export type CanonicalBindingInput = {
  title: string;
  extractionText: string;
  claimTexts: string[];
  concepts: Array<{ concept_id: string; term: string; definition?: string }>;
  systems: Array<{ system_id: string; name: string; components: string[]; interactions: string[] }>;
  equations: Array<{ equation_id: string; canonical_form: string; variable_ids: string[] }>;
};

type CanonicalTreeNode = {
  id?: string;
  title?: string;
  summary?: string;
  bodyMD?: string;
  tags?: unknown;
  evidence?: unknown;
  nodeType?: unknown;
};

type CanonicalTreeDoc = {
  nodes?: CanonicalTreeNode[];
};

type CanonicalIndexNode = {
  id: string;
  label: string;
  sourceTree: string;
  tags: string[];
  evidencePaths: string[];
  searchableText: string;
  tokens: Set<string>;
  nodeType: CanonicalDagNodeType;
};

export type CanonicalNodeDescriptor = CanonicalIndexNode;

type CanonicalRule = {
  canonicalId: string;
  targetTypes: CanonicalTargetType[];
  relation: CanonicalBindingRelation;
  keywords: string[];
  priority: number;
};

type CanonicalIndex = {
  byId: Map<string, CanonicalIndexNode>;
};

const CANONICAL_TREE_FILES = [
  "docs/knowledge/dp-collapse-tree.json",
  "docs/knowledge/physics/uncertainty-mechanics-tree.json",
  "docs/knowledge/physics/physics-foundations-tree.json",
  "docs/knowledge/physics/physics-microphysics-transport-tree.json",
  "docs/knowledge/physics/physics-gravitational-response-tree.json",
  "docs/knowledge/physics/physics-self-gravity-shape-tree.json",
  "docs/knowledge/physics/physics-stellar-structure-nucleosynthesis-tree.json",
  "docs/knowledge/physics/physics-quantum-semiclassical-tree.json",
  "docs/knowledge/physics/physics-thermodynamics-entropy-tree.json",
  "docs/knowledge/warp/warp-mechanics-tree.json",
  "docs/knowledge/bridges/stellar-ps1-bridge-tree.json",
  "docs/knowledge/bridges/astrochemistry-prebiotic-neuro-consciousness-bridge-tree.json",
  "docs/knowledge/certainty-framework-tree.json",
  "docs/knowledge/physics/math-tree.json",
  "docs/knowledge/physics/atomic-systems-tree.json",
  "docs/knowledge/halobank-solar-proof-tree.json",
] as const;

export const PAPER_CANONICAL_TREE_FILES = [...CANONICAL_TREE_FILES] as const;

const CANONICAL_RULES: CanonicalRule[] = [
  {
    canonicalId: "bridge-orch-or-to-stellar-coherence",
    targetTypes: ["concept", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "stellar consciousness",
      "stellar coherence",
      "solar consciousness",
      "sun consciousness",
      "stellar coherence bridge",
      "solar coherence bridge",
    ],
    priority: 0.1,
  },
  {
    canonicalId: "stellar-plasma-collapse-signature-model",
    targetTypes: ["system", "model", "equation"],
    relation: "refines",
    keywords: [
      "stellar plasma",
      "plasma collapse",
      "solar coherence",
      "flare cascade",
      "sun coherence",
      "terahertz",
    ],
    priority: 0.12,
  },
  {
    canonicalId: "bridge-noise-spectrum-to-collapse-proxy",
    targetTypes: ["system", "equation", "model"],
    relation: "refines",
    keywords: ["noise spectrum", "collapse proxy", "eeg", "delta wave", "gamma wave"],
    priority: 0.09,
  },
  {
    canonicalId: "dp-collapse-derivation",
    targetTypes: ["equation", "model", "concept"],
    relation: "derives_from",
    keywords: [
      "diosi penrose",
      "diosi-penrose",
      "penrose collapse",
      "wavefunction collapse",
      "wave function collapse",
      "objective reduction",
    ],
    priority: 0.14,
  },
  {
    canonicalId: "dp-collapse-estimator",
    targetTypes: ["model", "equation", "system"],
    relation: "derives_from",
    keywords: ["collapse estimator", "collapse time", "delta e", "tau", "r_c"],
    priority: 0.16,
  },
  {
    canonicalId: "uncertainty-collapse-constraints",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "collapse constraints",
      "collapse benchmark",
      "collapse bounds",
      "uncertainty collapse",
      "causal collapse",
    ],
    priority: 0.1,
  },
  {
    canonicalId: "uncertainty-coherence-window",
    targetTypes: ["concept", "system", "equation", "model"],
    relation: "equivalent_to",
    keywords: ["coherence window", "coherence bound", "coherence timing", "tau", "r_c", "causal sampling window"],
    priority: 0.1,
  },
  {
    canonicalId: "uncertainty-quantum-stochastic",
    targetTypes: ["concept", "equation", "model", "system"],
    relation: "equivalent_to",
    keywords: [
      "stochastic schrodinger",
      "stochastic schr",
      "quantum stochastic",
      "schrodinger wave function",
      "schrodinger equation",
      "noise kernel",
      "renormalized stress energy",
      "semiclassical stochastic",
    ],
    priority: 0.1,
  },
  {
    canonicalId: "uncertainty-mechanics-data-contract-definition",
    targetTypes: ["concept", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "uncertainty data contract",
      "uncertainty schema",
      "sigma container",
      "1 sigma",
      "band field",
      "propagated bands",
    ],
    priority: 0.1,
  },
  {
    canonicalId: "uncertainty-reality-bounds",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "reality bounds",
      "energy conditions",
      "quantum inequality",
      "negative energy bounds",
      "sampling window constraints",
    ],
    priority: 0.1,
  },
  {
    canonicalId: "atomic-quantum-route",
    targetTypes: ["equation", "concept", "model"],
    relation: "derives_from",
    keywords: ["wavefunction", "wave function", "schrodinger", "quantum orbital", "superposition"],
    priority: 0.08,
  },
  {
    canonicalId: "coherence-governor",
    targetTypes: ["system", "model"],
    relation: "refines",
    keywords: ["coherence governor", "collapse confidence", "coherence confidence"],
    priority: 0.08,
  },
  {
    canonicalId: "collapse-framework-constraints",
    targetTypes: ["system", "equation", "model"],
    relation: "refines",
    keywords: ["collapse framework constraints", "collapse policy gate", "causal footprint"],
    priority: 0.07,
  },
  {
    canonicalId: "stress-energy-equations",
    targetTypes: ["equation", "model"],
    relation: "derives_from",
    keywords: ["stress-energy tensor", "t00", "einstein tensor", "stress energy equations"],
    priority: 0.07,
  },
  {
    canonicalId: "solar-energy-calibration",
    targetTypes: ["system", "model"],
    relation: "refines",
    keywords: ["solar energy", "solar calibration", "stellar energy"],
    priority: 0.05,
  },
  {
    canonicalId: "halobank-solar-metric-context",
    targetTypes: ["concept", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "metric context",
      "weak field",
      "post newtonian",
      "ppn",
      "harmonic gauge",
      "bcrs",
      "gcrs",
      "source potentials",
    ],
    priority: 0.09,
  },
  {
    canonicalId: "halobank-solar-reference-frame",
    targetTypes: ["concept", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "reference frame",
      "barycentric celestial reference system",
      "geocentric celestial reference system",
      "bcrs",
      "gcrs",
      "icrs",
      "target minus reference",
    ],
    priority: 0.09,
  },
  {
    canonicalId: "halobank-solar-time-scale",
    targetTypes: ["concept", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "time scale",
      "terrestrial time",
      "barycentric dynamical time",
      "barycentric coordinate time",
      "geocentric coordinate time",
      "utc",
      "tai",
      "tt",
      "tdb",
      "tcb",
      "tcg",
    ],
    priority: 0.09,
  },
  {
    canonicalId: "halobank-solar-observer-context",
    targetTypes: ["concept", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "observer context",
      "observer state",
      "proper time",
      "geocenter",
      "body fixed",
      "topocentric",
      "observer worldline",
    ],
    priority: 0.1,
  },
  {
    canonicalId: "halobank-solar-signal-path",
    targetTypes: ["concept", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "signal path",
      "null geodesic",
      "light time",
      "shapiro delay",
      "light deflection",
      "aberration",
      "line of sight",
      "occultation geometry",
    ],
    priority: 0.1,
  },
  {
    canonicalId: "physics-foundations-metric-definition",
    targetTypes: ["concept", "model"],
    relation: "equivalent_to",
    keywords: [
      "metric definition",
      "spacetime metric",
      "metric tensor",
      "line element",
      "interval",
      "sign convention",
      "chart contract",
    ],
    priority: 0.08,
  },
  {
    canonicalId: "physics-foundations-field-equation-definition",
    targetTypes: ["concept", "equation", "model"],
    relation: "equivalent_to",
    keywords: [
      "einstein field equations",
      "field equation",
      "adm 3+1",
      "lapse shift",
      "extrinsic curvature",
      "constraint equation",
    ],
    priority: 0.08,
  },
  {
    canonicalId: "physics-foundations-stress-energy-definition",
    targetTypes: ["concept", "equation", "model"],
    relation: "equivalent_to",
    keywords: [
      "stress energy tensor",
      "stress-energy tensor",
      "energy momentum tensor",
      "t00",
      "matter source",
      "curvature source",
    ],
    priority: 0.08,
  },
  {
    canonicalId: "physics-foundations-units-definition",
    targetTypes: ["concept", "model"],
    relation: "equivalent_to",
    keywords: [
      "units conversion",
      "geometric units",
      "si units",
      "dimensional analysis",
      "scaling laws",
      "fundamental constants",
    ],
    priority: 0.07,
  },
  {
    canonicalId: "physics-foundations-viability-definition",
    targetTypes: ["concept", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "viability definition",
      "claim limits",
      "claim tier",
      "certificate integrity",
      "no feasibility claims",
      "evidence gate",
    ],
    priority: 0.07,
  },
  {
    canonicalId: "physics-microphysics-transport-effective-microphysics-definition",
    targetTypes: ["concept", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "effective microphysics",
      "reduced microphysics",
      "microphysical coefficients",
      "effective transport coefficients",
      "microphysics to coarse grained transport",
      "particle physics to bulk coefficients",
    ],
    priority: 0.22,
  },
  {
    canonicalId: "physics-microphysics-transport-effective-interaction-hamiltonian-definition",
    targetTypes: ["concept", "system", "equation", "model"],
    relation: "equivalent_to",
    keywords: [
      "effective interaction hamiltonian",
      "interaction hamiltonian",
      "reduced hamiltonian",
      "effective hamiltonian",
      "microphysics hamiltonian",
      "hamiltonian backbone",
    ],
    priority: 0.22,
  },
  {
    canonicalId: "physics-microphysics-transport-kinetic-transport-closure-definition",
    targetTypes: ["concept", "system", "equation", "model"],
    relation: "equivalent_to",
    keywords: [
      "kinetic transport closure",
      "transport closure",
      "coarse grained closure",
      "constitutive closure",
      "kinetic hierarchy closure",
      "closure for transport and response",
    ],
    priority: 0.22,
  },
  {
    canonicalId: "physics-microphysics-transport-constitutive-response-definition",
    targetTypes: ["concept", "system", "equation", "model"],
    relation: "equivalent_to",
    keywords: [
      "constitutive response",
      "constitutive law",
      "bulk constitutive response",
      "material closure",
      "stress strain rheology",
    ],
    priority: 0.22,
  },
  {
    canonicalId: "physics-microphysics-transport-plasma-transport-closure-definition",
    targetTypes: ["concept", "system", "equation", "model"],
    relation: "equivalent_to",
    keywords: [
      "plasma transport closure",
      "stellar transport closure",
      "transport closure in plasma",
      "plasma transport",
      "mhd closure",
      "kinetic to fluid closure",
    ],
    priority: 0.22,
  },
  {
    canonicalId: "physics-microphysics-transport-collective-observable-response-definition",
    targetTypes: ["concept", "system", "equation", "model"],
    relation: "equivalent_to",
    keywords: [
      "collective observable response",
      "observable response diagnostics",
      "observable response in macroscopic systems",
      "closure level observables",
      "collective response observables",
    ],
    priority: 0.22,
  },
  {
    canonicalId: "physics-thermodynamics-many-body-hamiltonian-definition",
    targetTypes: ["concept", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "effective microphysics",
      "microphysics",
      "effective interaction hamiltonian",
      "interaction hamiltonian",
      "many body hamiltonian",
      "many-body hamiltonian",
      "microphysics hamiltonian",
      "statistical mechanics",
      "partition function",
      "free energy",
      "external potential",
      "continuum limits",
    ],
    priority: 0.18,
  },
  {
    canonicalId: "physics-thermodynamics-intermolecular-potential-definition",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "born oppenheimer",
      "born-oppenheimer",
      "effective intermolecular potential",
      "intermolecular potential",
      "potential energy surface",
      "sapt",
      "lennard jones",
      "dispersion",
      "pauli repulsion",
    ],
    priority: 0.17,
  },
  {
    canonicalId: "physics-thermodynamics-structure-response-definition",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "pair correlation",
      "g(r)",
      "h(r)",
      "static structure factor",
      "structure factor",
      "s(k)",
      "compressibility sum rule",
      "isothermal compressibility",
      "linear response",
      "delta n(k)",
    ],
    priority: 0.17,
  },
  {
    canonicalId: "physics-thermodynamics-virial-equation-of-state-definition",
    targetTypes: ["concept", "equation", "model"],
    relation: "equivalent_to",
    keywords: [
      "virial coefficient",
      "virial coefficients",
      "compressibility factor",
      "equation of state",
      "mayer f function",
      "second virial coefficient",
      "z=1+b2",
      "z = 1 + b2",
    ],
    priority: 0.16,
  },
  {
    canonicalId: "physics-thermodynamics-classical-density-functional-response-definition",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "classical density functional theory",
      "cdft",
      "kinetic transport closure",
      "transport closure",
      "coarse grained closure",
      "constitutive closure",
      "grand potential",
      "helmholtz free energy",
      "chemical potential",
      "delta f/delta n",
      "external potential minimization",
      "nonuniform fluid",
      "u_ext",
    ],
    priority: 0.18,
  },
  {
    canonicalId: "physics-thermodynamics-equilibrium-tide-definition",
    targetTypes: ["concept", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "equilibrium tide",
      "tidal potential",
      "hydrostatic balance",
      "equipotential",
      "tide generating force",
      "gravity potential",
      "free surface",
      "forced dissipative",
    ],
    priority: 0.17,
  },
  {
    canonicalId: "physics-thermodynamics-optical-trapping-definition",
    targetTypes: ["concept", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "optical trapping",
      "optical trap",
      "optical tweezers",
      "optical potential",
      "dipole potential",
      "gradient force",
      "rayleigh regime",
      "polarizability",
      "boltzmann distribution",
    ],
    priority: 0.17,
  },
  {
    canonicalId: "physics-gravitational-response-lunisolar-tide-potential-definition",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "tide generating potential",
      "tide-generating potential",
      "tide raising force",
      "tide-raising force",
      "tractive force",
      "lunisolar forcing",
      "inverse cube",
      "moon and sun forcing",
    ],
    priority: 0.18,
  },
  {
    canonicalId: "physics-gravitational-response-tidal-tensor-definition",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "tidal tensor",
      "gravity gradient tensor",
      "hessian of the potential",
      "second derivative of the gravitational potential",
      "weak field tidal tensor",
    ],
    priority: 0.18,
  },
  {
    canonicalId: "physics-gravitational-response-love-number-definition",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "love number",
      "k2",
      "h2",
      "l2",
      "dimensionless tidal response",
      "tidal response coefficient",
    ],
    priority: 0.18,
  },
  {
    canonicalId: "physics-gravitational-response-dynamic-tide-definition",
    targetTypes: ["concept", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "dynamic tide",
      "forced dissipative tide",
      "forced-dissipative tide",
      "rotating shallow water",
      "harmonic constituent",
      "amphidrome",
      "basin resonance",
      "coriolis",
    ],
    priority: 0.17,
  },
  {
    canonicalId: "physics-gravitational-response-equatorial-bulge-torque-definition",
    targetTypes: ["concept", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "equatorial bulge torque",
      "torque on earth's equatorial bulge",
      "equatorial bulge",
      "earth oblateness torque",
      "luni-solar torque",
      "moon and sun acting on earth's equatorial bulge",
    ],
    priority: 0.15,
  },
  {
    canonicalId: "physics-gravitational-response-dynamical-ellipticity-definition",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "dynamical ellipticity",
      "dynamic ellipticity",
      "H = (C - A)/C",
      "earth dynamical ellipticity",
      "rotation figure inertia asymmetry",
    ],
    priority: 0.18,
  },
  {
    canonicalId: "physics-gravitational-response-precession-constant-definition",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "precession constant",
      "lunisolar precession constant",
      "precession rate from torque",
      "spin axis precession constant",
      "precession constant from lunisolar torque",
    ],
    priority: 0.18,
  },
  {
    canonicalId: "physics-gravitational-response-earth-axial-precession-definition",
    targetTypes: ["concept", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "earth axial precession",
      "precession of the equinoxes",
      "spin axis precession",
      "earth's spin axis",
      "26000 years",
      "equatorial bulge precession",
    ],
    priority: 0.2,
  },
  {
    canonicalId: "physics-gravitational-response-earth-nutation-definition",
    targetTypes: ["concept", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "earth nutation",
      "nutation of earth's axis",
      "spin axis nutation",
      "tilted elliptical orbit",
      "shorter time scales",
      "bumpy spin axis",
    ],
    priority: 0.19,
  },
  {
    canonicalId: "physics-self-gravity-shape-self-gravity-definition",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "self gravity",
      "self-gravity",
      "self gravitating body",
      "gravitational self attraction",
      "body's own gravity",
    ],
    priority: 0.17,
  },
  {
    canonicalId: "physics-self-gravity-shape-internal-pressure-definition",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "internal pressure",
      "pressure support",
      "pressure gradient support",
      "self gravity pressure balance",
      "hydrostatic support",
    ],
    priority: 0.16,
  },
  {
    canonicalId: "physics-self-gravity-shape-constitutive-response-definition",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "constitutive response",
      "constitutive law",
      "stress strain rheology",
      "material closure",
      "deformation law",
    ],
    priority: 0.17,
  },
  {
    canonicalId: "physics-self-gravity-shape-material-strength-definition",
    targetTypes: ["concept", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "material strength",
      "yield strength",
      "rigidity",
      "rheology",
      "elastic strength",
    ],
    priority: 0.15,
  },
  {
    canonicalId: "physics-self-gravity-shape-hydrostatic-equilibrium-shape-definition",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "hydrostatic equilibrium shape",
      "hydrostatic figure",
      "rounded equilibrium figure",
      "nearly round",
      "hydrostatic shape",
    ],
    priority: 0.2,
  },
  {
    canonicalId: "physics-self-gravity-shape-rotational-flattening-definition",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "rotational flattening",
      "rotational oblateness",
      "equatorial flattening",
      "centrifugal flattening",
      "maclaurin spheroid",
    ],
    priority: 0.17,
  },
  {
    canonicalId: "physics-self-gravity-shape-J2-definition",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "J2",
      "quadrupole gravity coefficient",
      "oblateness coefficient",
      "zonal harmonic J2",
      "gravity field quadrupole",
    ],
    priority: 0.18,
  },
  {
    canonicalId: "physics-self-gravity-shape-tidal-bulge-response-definition",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "tidal bulge response",
      "tidal deformation",
      "tidal response",
      "love number",
      "bulge phase lag",
    ],
    priority: 0.17,
  },
  {
    canonicalId: "physics-self-gravity-shape-planetary-figure-diagnostic",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "planetary figure diagnostic",
      "j2 flattening diagnostic",
      "earth like figure closure",
      "q j2 h k2 flattening",
      "low order planetary figure",
    ],
    priority: 0.18,
  },
  {
    canonicalId: "physics-self-gravity-shape-potato-radius-transition-definition",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "potato radius",
      "potato-radius",
      "rounding threshold",
      "irregular to rounded",
      "dwarf planet rounding",
    ],
    priority: 0.2,
  },
  {
    canonicalId: "physics-self-gravity-shape-granular-collision-dissipation-definition",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "granular collision dissipation",
      "multiparticle collisions",
      "granular dissipation",
      "inelastic grain collisions",
      "grain contact dissipation",
      "rubble pile collisions",
    ],
    priority: 0.18,
  },
  {
    canonicalId: "physics-self-gravity-shape-porous-rubble-pile-rheology-definition",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "porous rubble pile rheology",
      "rubble pile rheology",
      "granular rheology",
      "porous aggregate rheology",
      "effective bulk rheology",
      "self gravitating rubble pile",
    ],
    priority: 0.18,
  },
  {
    canonicalId: "physics-self-gravity-shape-tidal-quality-factor-definition",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "tidal quality factor",
      "tidal q",
      "quality factor q",
      "k2 over q",
      "tidal dissipation factor",
      "phase lag dissipation",
    ],
    priority: 0.18,
  },
  {
    canonicalId: "physics-self-gravity-shape-spin-state-evolution-definition",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "spin state evolution",
      "spin evolution",
      "rotation state evolution",
      "despinning",
      "spin up spin down",
      "tidal spin evolution",
    ],
    priority: 0.18,
  },
  {
    canonicalId: "physics-self-gravity-shape-angular-momentum-redistribution-definition",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "angular momentum redistribution",
      "angular momentum exchange",
      "tidal angular momentum transfer",
      "spin orbit angular momentum exchange",
      "torque driven spin redistribution",
      "rotational angular momentum transfer",
    ],
    priority: 0.18,
  },
  {
    canonicalId: "physics-stellar-structure-nucleosynthesis-stellar-hydrostatic-equilibrium-definition",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "stellar hydrostatic equilibrium",
      "hydrostatic support in stars",
      "pressure balances gravity in a star",
      "stellar force balance",
    ],
    priority: 0.18,
  },
  {
    canonicalId: "physics-stellar-structure-nucleosynthesis-stellar-thermal-equilibrium-definition",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "stellar thermal equilibrium",
      "energy generation and transport balance",
      "stellar thermal balance",
      "radiative convective balance",
    ],
    priority: 0.17,
  },
  {
    canonicalId: "physics-stellar-structure-nucleosynthesis-stellar-equation-of-state-definition",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "stellar equation of state",
      "stellar plasma eos",
      "plasma equation of state",
      "plasma transport closure",
      "stellar transport closure",
      "transport closure in plasma",
      "degeneracy pressure",
    ],
    priority: 0.19,
  },
  {
    canonicalId: "physics-stellar-structure-nucleosynthesis-stellar-opacity-definition",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "stellar opacity",
      "rosseland mean opacity",
      "radiative opacity",
      "opacity transport",
    ],
    priority: 0.16,
  },
  {
    canonicalId: "physics-stellar-structure-nucleosynthesis-nuclear-reaction-rate-definition",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "nuclear reaction rate",
      "fusion rate",
      "thermonuclear reaction rate",
      "reaction network",
      "thermally averaged cross section",
    ],
    priority: 0.17,
  },
  {
    canonicalId: "physics-stellar-structure-nucleosynthesis-hydrogen-burning-definition",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "hydrogen burning",
      "proton proton chain",
      "pp chain",
      "cno cycle",
      "main sequence fusion",
    ],
    priority: 0.19,
  },
  {
    canonicalId: "physics-stellar-structure-nucleosynthesis-helium-burning-definition",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "helium burning",
      "triple alpha",
      "triple-alpha",
      "helium fusion stage",
    ],
    priority: 0.19,
  },
  {
    canonicalId: "physics-stellar-structure-nucleosynthesis-advanced-burning-stages-definition",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "advanced burning stages",
      "carbon burning",
      "oxygen burning",
      "silicon burning",
      "late stellar burning",
    ],
    priority: 0.18,
  },
  {
    canonicalId: "physics-stellar-structure-nucleosynthesis-stellar-nucleosynthesis-definition",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "stellar nucleosynthesis",
      "element creation in stars",
      "stellar abundance yields",
      "b2fh",
    ],
    priority: 0.19,
  },
  {
    canonicalId: "physics-stellar-structure-nucleosynthesis-composition-feedback-definition",
    targetTypes: ["concept", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "composition feedback",
      "metallicity feedback",
      "abundance feedback",
      "opacity feedback",
      "composition evolution",
    ],
    priority: 0.16,
  },
  {
    canonicalId: "physics-stellar-structure-nucleosynthesis-stellar-oscillation-definition",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "stellar oscillation",
      "p mode",
      "p-mode",
      "g mode",
      "global stellar oscillation",
      "five minute oscillation",
    ],
    priority: 0.19,
  },
  {
    canonicalId: "physics-stellar-structure-nucleosynthesis-helioseismology-definition",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "helioseismology",
      "solar oscillation inversion",
      "helioseismic inversion",
      "interior sound speed inversion",
      "probe the solar interior with oscillations",
    ],
    priority: 0.19,
  },
  {
    canonicalId: "physics-stellar-structure-nucleosynthesis-solar-dynamo-definition",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "solar dynamo",
      "stellar dynamo",
      "rotation convection magnetic field generation",
      "alpha omega dynamo",
      "magnetic field generation in the sun",
    ],
    priority: 0.18,
  },
  {
    canonicalId: "physics-stellar-structure-nucleosynthesis-magnetic-cycle-definition",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "magnetic cycle",
      "solar cycle",
      "activity cycle",
      "sunspot cycle",
      "polarity reversal cycle",
    ],
    priority: 0.18,
  },
  {
    canonicalId: "physics-stellar-structure-nucleosynthesis-magnetic-reconnection-definition",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "magnetic reconnection",
      "field line reconnection",
      "coronal reconnection",
      "magnetic free energy release",
      "topological magnetic reconnection",
    ],
    priority: 0.18,
  },
  {
    canonicalId: "physics-stellar-structure-nucleosynthesis-flare-avalanche-definition",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "flare avalanche",
      "solar flare avalanche",
      "self organized critical flare statistics",
      "soc flare cascade",
      "flare power law statistics",
    ],
    priority: 0.18,
  },
  {
    canonicalId: "physics-stellar-structure-nucleosynthesis-multiscale-plasma-variability-definition",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "multiscale plasma variability",
      "stellar plasma variability",
      "oscillation dynamo reconnection stack",
      "coupled stellar variability",
      "multiscale solar variability",
    ],
    priority: 0.18,
  },
  {
    canonicalId: "physics-stellar-structure-nucleosynthesis-stellar-observables-diagnostic",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "stellar observables diagnostic",
      "helioseismic activity correlation",
      "p mode frequency shift activity relation",
      "solar observables diagnostic",
      "magnetic activity and helioseismic shifts",
      "collective observable response",
      "observable response diagnostics",
    ],
    priority: 0.19,
  },
  {
    canonicalId: "physics-stellar-structure-nucleosynthesis-granulation-driven-pmode-pumping-definition",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "granulation driven p mode pumping",
      "granulation driven p-mode pumping",
      "granule driven p mode",
      "convection driven p mode excitation",
      "five minute mode pumping",
      "granulation excites p modes",
    ],
    priority: 0.19,
  },
  {
    canonicalId: "physics-stellar-structure-nucleosynthesis-nanoflare-heating-definition",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "nanoflare heating",
      "nanoflare coronal heating",
      "impulsive coronal heating",
      "parker nanoflare",
      "small scale flare heating",
      "coronal nanoflares",
    ],
    priority: 0.18,
  },
  {
    canonicalId: "physics-stellar-structure-nucleosynthesis-flare-particle-precipitation-definition",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "flare particle precipitation",
      "electron beam precipitation",
      "flare precipitation",
      "chromospheric impact heating",
      "thick target precipitation",
      "particle precipitation in flares",
    ],
    priority: 0.18,
  },
  {
    canonicalId: "physics-stellar-structure-nucleosynthesis-sunquake-definition",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "sunquake",
      "solar quake",
      "helioseismic flare response",
      "flare driven acoustic transient",
      "solar seismic response",
      "flare excited seismic wave",
    ],
    priority: 0.19,
  },
  {
    canonicalId: "physics-stellar-structure-nucleosynthesis-flare-sunquake-timing-correlation-definition",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "flare sunquake timing correlation",
      "flare-to-sunquake timing",
      "euv sunquake timing",
      "flare onset and sunquake",
      "flare sunquake alignment",
      "sunquake timing replay",
    ],
    priority: 0.19,
  },
  {
    canonicalId: "physics-stellar-structure-nucleosynthesis-quasi-periodic-flare-envelope-definition",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "quasi periodic flare envelope",
      "quasi-periodic flare envelope",
      "quasi periodic pulsation",
      "flare burst envelope",
      "qpp flare",
      "flare recurrence envelope",
    ],
    priority: 0.18,
  },
  {
    canonicalId: "physics-stellar-structure-nucleosynthesis-magnetic-striation-hierarchy-definition",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "magnetic striation hierarchy",
      "solar magnetic curtains",
      "striated solar photosphere",
      "magnetic striations",
      "ultra fine striations",
      "multiscale magnetic morphology",
    ],
    priority: 0.17,
  },
  {
    canonicalId: "stellar-carbon-synthesis",
    targetTypes: ["concept", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "stellar carbon synthesis",
      "carbon production in stars",
      "triple alpha carbon",
      "carbon enrichment from stars",
    ],
    priority: 0.16,
  },
  {
    canonicalId: "interstellar-aromatic-carbon-chemistry",
    targetTypes: ["concept", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "interstellar aromatic carbon chemistry",
      "aromatic carbon chemistry in space",
      "benzene in space",
      "aromatic molecules in circumstellar environments",
    ],
    priority: 0.16,
  },
  {
    canonicalId: "interstellar-pah-chemistry",
    targetTypes: ["concept", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "interstellar pah chemistry",
      "polycyclic aromatic hydrocarbon",
      "pah bands",
      "uib aromatic signature",
    ],
    priority: 0.16,
  },
  {
    canonicalId: "meteoritic-prebiotic-organic-delivery",
    targetTypes: ["concept", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "meteoritic prebiotic organic delivery",
      "meteorite organics",
      "exogenous delivery of organics",
      "carbonaceous meteorite organics",
    ],
    priority: 0.18,
  },
  {
    canonicalId: "prebiotic-organic-inventory",
    targetTypes: ["concept", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "prebiotic organic inventory",
      "prebiotic inventory",
      "abiotic organic inventory",
      "delivered organics before life",
    ],
    priority: 0.16,
  },
  {
    canonicalId: "terrestrial-catecholamine-biosynthesis",
    targetTypes: ["concept", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "catecholamine biosynthesis",
      "dopamine biosynthesis",
      "tyrosine hydroxylase",
      "l dopa to dopamine",
    ],
    priority: 0.17,
  },
  {
    canonicalId: "dopamine-reward-signaling",
    targetTypes: ["concept", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "dopamine reward signaling",
      "reward prediction error",
      "dopamine reinforcement",
      "motivation and action selection",
    ],
    priority: 0.18,
  },
  {
    canonicalId: "quantum-consciousness-hypothesis",
    targetTypes: ["concept", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "quantum consciousness hypothesis",
      "quantum consciousness",
      "consciousness and quantum theory",
      "collapse and consciousness",
      "microtubule time crystal",
      "polyatomic time crystal",
      "triplet of triplets",
      "triplets of triplets",
      "triplet hierarchy",
      "scale free resonance hierarchy",
      "scale-free resonance hierarchy",
      "spacetime triplet geometry",
      "microtubule triplet resonance",
      "bandyopadhyay",
      "anirban bandyopadhyay",
      "saxena",
    ],
    priority: 0.15,
  },
  {
    canonicalId: "orch-or-hypothesis",
    targetTypes: ["concept", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "orch or hypothesis",
      "orchestrated objective reduction",
      "hameroff penrose",
      "microtubule quantum coherence",
      "microtubule objective reduction",
      "diosi penrose",
      "gravity related collapse",
      "microtubule vibrational mode",
      "microtubule energy migration",
      "microtubule triplet resonance",
      "microtubule time crystal",
      "triplet of triplets",
      "polyatomic time crystal",
      "scale free resonance hierarchy",
    ],
    priority: 0.18,
  },
  {
    canonicalId: "conscious-experience-mapping",
    targetTypes: ["concept", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "conscious experience mapping",
      "physical correlates of experience",
      "mapping physical process to experience",
      "phenomenal mapping",
    ],
    priority: 0.14,
  },
  {
    canonicalId: "stellar-plasma-observables-not-consciousness",
    targetTypes: ["concept", "claim", "model"],
    relation: "equivalent_to",
    keywords: [
      "stellar plasma observables not consciousness",
      "stellar plasma is not consciousness",
      "no direct stellar consciousness inference",
      "solar plasma observables are not consciousness",
      "stellar coherence guardrail",
    ],
    priority: 0.18,
  },
  {
    canonicalId: "sunquake_not_quantum_collapse",
    targetTypes: ["concept", "model", "system"],
    relation: "equivalent_to",
    keywords: [
      "sunquake not quantum collapse",
      "sunquake observables not collapse",
      "flare sunquake is not consciousness",
      "sunquake guardrail",
      "no quantum collapse inference from sunquakes",
    ],
    priority: 0.18,
  },
  {
    canonicalId: "physics-quantum-semiclassical-quantum-statistics-definition",
    targetTypes: ["concept", "equation", "model"],
    relation: "equivalent_to",
    keywords: [
      "quantum statistics",
      "thermal de broglie wavelength",
      "bose",
      "fermi",
      "degeneracy pressure",
      "superfluid",
      "superfluid helium",
    ],
    priority: 0.17,
  },
  {
    canonicalId: "physics-quantum-semiclassical-decoherence-classicality-definition",
    targetTypes: ["concept", "model"],
    relation: "equivalent_to",
    keywords: [
      "decoherence",
      "pointer states",
      "einselection",
      "classicality",
      "classical limit",
      "environmental coupling",
      "macroscopically distinct",
      "gravitational time dilation decoherence",
      "gravity linked decoherence",
      "gravity time dilation decoherence",
    ],
    priority: 0.16,
  },
  {
    canonicalId: "physics-quantum-semiclassical-stochastic-open-quantum-dynamics-definition",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "stochastic open quantum dynamics",
      "open quantum system with stochastic evolution",
      "collapse model family",
      "stochastic collapse dynamics",
      "open system quantum unraveling",
      "gravity related collapse",
      "gravitational collapse",
      "objective reduction",
      "driven dissipative time crystal",
      "subharmonic locking",
      "time crystal robustness",
      "time crystal no go theorem",
    ],
    priority: 0.17,
  },
  {
    canonicalId: "physics-quantum-semiclassical-stochastic-schrodinger-equation-definition",
    targetTypes: ["concept", "equation", "model"],
    relation: "equivalent_to",
    keywords: [
      "stochastic schrodinger equation",
      "stochastic wavefunction evolution",
      "sse open quantum dynamics",
      "noise driven schrodinger equation",
      "stochastic pure state evolution",
    ],
    priority: 0.17,
  },
  {
    canonicalId: "physics-quantum-semiclassical-csl-definition",
    targetTypes: ["concept", "equation", "model"],
    relation: "equivalent_to",
    keywords: [
      "continuous spontaneous localization",
      "csl",
      "csl collapse model",
      "mass density collapse model",
      "collapse localization dynamics",
    ],
    priority: 0.17,
  },
  {
    canonicalId: "physics-quantum-semiclassical-colored-noise-collapse-hypothesis",
    targetTypes: ["concept", "equation", "model"],
    relation: "equivalent_to",
    keywords: [
      "colored noise collapse",
      "non markovian collapse noise",
      "colored noise collapse model",
      "colored noise stochastic collapse",
      "non white collapse noise",
    ],
    priority: 0.16,
  },
  {
    canonicalId: "alcubierre-metric",
    targetTypes: ["concept", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "alcubierre metric",
      "alcubierre warp",
      "warp drive metric",
      "shift only warp metric",
      "expansion contraction bubble",
    ],
    priority: 0.1,
  },
  {
    canonicalId: "natario-zero-expansion",
    targetTypes: ["concept", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "natario warp",
      "natario metric",
      "zero expansion warp",
      "divergence free shift",
      "zero expansion bubble",
    ],
    priority: 0.1,
  },
  {
    canonicalId: "shift-vector-expansion-scalar",
    targetTypes: ["concept", "equation", "model"],
    relation: "equivalent_to",
    keywords: [
      "shift vector",
      "expansion scalar",
      "divergence of shift",
      "theta",
      "adm shift",
      "zero expansion condition",
    ],
    priority: 0.09,
  },
  {
    canonicalId: "vdb-compression-factor",
    targetTypes: ["concept", "model"],
    relation: "equivalent_to",
    keywords: [
      "van den broeck",
      "vdb metric",
      "compression factor",
      "gamma_vdb",
      "pocket geometry",
      "reduced energy requirements",
    ],
    priority: 0.09,
  },
  {
    canonicalId: "physics-self-gravity-shape-granular-collision-dissipation-definition",
    targetTypes: ["concept", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "granular collision dissipation",
      "contact dissipation",
      "rubble pile dissipation",
      "inelastic contacts",
      "frictional heating",
    ],
    priority: 0.17,
  },
  {
    canonicalId: "physics-self-gravity-shape-porous-rubble-pile-rheology-definition",
    targetTypes: ["concept", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "porous rubble pile rheology",
      "rubble pile rheology",
      "aggregate rheology",
      "porosity friction cohesion",
      "effective bulk rheology",
    ],
    priority: 0.17,
  },
  {
    canonicalId: "physics-self-gravity-shape-tidal-quality-factor-definition",
    targetTypes: ["concept", "equation", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "tidal quality factor",
      "q factor",
      "tidal damping",
      "dissipation per cycle",
      "inverse q",
    ],
    priority: 0.18,
  },
  {
    canonicalId: "physics-self-gravity-shape-spin-state-evolution-definition",
    targetTypes: ["concept", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "spin state evolution",
      "spin evolution",
      "obliquity evolution",
      "spin orbit evolution",
      "tidal torque",
    ],
    priority: 0.18,
  },
  {
    canonicalId: "physics-self-gravity-shape-angular-momentum-redistribution-definition",
    targetTypes: ["concept", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "angular momentum redistribution",
      "spin orbit exchange",
      "tidal angular momentum exchange",
      "reservoir exchange",
      "angular momentum exchange",
    ],
    priority: 0.17,
  },
  {
    canonicalId: "physics-self-gravity-shape-granular-tidal-response-diagnostic",
    targetTypes: ["concept", "system", "model", "equation"],
    relation: "equivalent_to",
    keywords: [
      "granular tidal response diagnostic",
      "rubble pile tidal response diagnostic",
      "granular tidal response",
      "tidal damping spin state",
      "low order rubble pile diagnostic",
    ],
    priority: 0.18,
  },
  {
    canonicalId: "physics-stellar-structure-nucleosynthesis-granulation-driven-pmode-pumping-definition",
    targetTypes: ["concept", "system", "model", "equation"],
    relation: "equivalent_to",
    keywords: [
      "granulation driven p mode pumping",
      "granulation p mode pumping",
      "five minute p mode forcing",
      "granulation convective p modes",
      "p-mode pumping",
    ],
    priority: 0.18,
  },
  {
    canonicalId: "physics-stellar-structure-nucleosynthesis-nanoflare-heating-definition",
    targetTypes: ["concept", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "nanoflare heating",
      "coronal heating by nanoflares",
      "impulsive magnetic heating",
      "nanoflare corona",
    ],
    priority: 0.18,
  },
  {
    canonicalId: "physics-stellar-structure-nucleosynthesis-flare-particle-precipitation-definition",
    targetTypes: ["concept", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "flare particle precipitation",
      "particle precipitation",
      "flare forcing",
      "energetic particles lower atmosphere",
    ],
    priority: 0.18,
  },
  {
    canonicalId: "physics-stellar-structure-nucleosynthesis-sunquake-definition",
    targetTypes: ["concept", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "sunquake",
      "flare driven sunquake",
      "helioseismic surface response",
      "sunquake response",
    ],
    priority: 0.19,
  },
  {
    canonicalId: "physics-stellar-structure-nucleosynthesis-flare-sunquake-timing-correlation-definition",
    targetTypes: ["concept", "system", "model", "equation"],
    relation: "equivalent_to",
    keywords: [
      "flare sunquake timing correlation",
      "sunquake timing correlation",
      "flare to sunquake timing",
      "euv irradiance sunquake timing",
    ],
    priority: 0.19,
  },
  {
    canonicalId: "physics-stellar-structure-nucleosynthesis-quasi-periodic-flare-envelope-definition",
    targetTypes: ["concept", "system", "model", "equation"],
    relation: "equivalent_to",
    keywords: [
      "quasi periodic flare envelope",
      "flare envelope",
      "quasi periodic pulsations",
      "burst envelope",
      "qpp",
    ],
    priority: 0.18,
  },
  {
    canonicalId: "physics-stellar-structure-nucleosynthesis-magnetic-striation-hierarchy-definition",
    targetTypes: ["concept", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "magnetic striation hierarchy",
      "magnetic curtains",
      "striated solar photosphere",
      "magnetic striation",
      "multiscale magnetic texture",
    ],
    priority: 0.17,
  },
  {
    canonicalId: "physics-stellar-structure-nucleosynthesis-sunquake-timing-replay-diagnostic",
    targetTypes: ["concept", "system", "model", "equation"],
    relation: "equivalent_to",
    keywords: [
      "sunquake timing replay diagnostic",
      "sunquake replay lane",
      "flare timing replay",
      "granulation-pumped p-mode power",
      "sunquake timing replay",
    ],
    priority: 0.2,
  },
  {
    canonicalId: "sunquake_not_quantum_collapse",
    targetTypes: ["concept", "system", "model"],
    relation: "equivalent_to",
    keywords: [
      "sunquake not quantum collapse",
      "sunquake collapse",
      "flare timing promoted to consciousness",
      "no stellar observable to collapse bridge",
    ],
    priority: 0.18,
  },
];

export const PAPER_CANONICAL_RULES: ReadonlyArray<CanonicalRule> = CANONICAL_RULES;

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "between",
  "within",
  "under",
  "over",
  "across",
  "about",
  "paper",
  "review",
  "model",
  "theory",
  "system",
  "systems",
  "framework",
  "concept",
  "concepts",
  "value",
  "values",
  "equation",
  "equations",
]);

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_\-]+/g, " ")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value: string): string[] {
  const normalized = normalizeText(value);
  if (!normalized) return [];
  return normalized
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

function normalizeStringArray(value: unknown): string[] {
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

function inferNodeType(node: CanonicalTreeNode): CanonicalDagNodeType {
  const explicitNodeType = normalizeText(typeof node.nodeType === "string" ? node.nodeType : "");
  if (explicitNodeType === "definition") return "definition";
  const tags = normalizeStringArray(node.tags).map((tag) => normalizeText(tag));
  const id = normalizeText(node.id ?? "");
  const merged = `${id} ${tags.join(" ")}`;
  if (/\b(definition|contract)\b/.test(merged)) return "definition";
  if (/\b(equation|tensor|derivation|estimate|estimator|solver)\b/.test(merged)) return "equation";
  if (/\b(model|adapter|route)\b/.test(merged)) return "model";
  if (/\b(system|coherence|governor|stack|window)\b/.test(merged)) return "system";
  if (/\b(bridge|constraints|policy)\b/.test(merged)) return "theory";
  return "entity";
}

async function loadCanonicalIndex(repoRoot: string): Promise<CanonicalIndex> {
  const byId = new Map<string, CanonicalIndexNode>();
  for (const relativePath of CANONICAL_TREE_FILES) {
    const absolutePath = path.resolve(repoRoot, relativePath);
    let parsed: CanonicalTreeDoc;
    try {
      const raw = await fs.readFile(absolutePath, "utf8");
      parsed = JSON.parse(raw) as CanonicalTreeDoc;
    } catch {
      continue;
    }
    for (const node of parsed.nodes ?? []) {
      const nodeId = typeof node.id === "string" ? node.id.trim() : "";
      if (!nodeId) continue;
      const label = (typeof node.title === "string" && node.title.trim().length > 0
        ? node.title
        : nodeId
      ).trim();
      const tags = normalizeStringArray(node.tags);
      const searchableText = [
        nodeId,
        label,
        typeof node.summary === "string" ? node.summary : "",
        typeof node.bodyMD === "string" ? node.bodyMD : "",
        ...tags,
      ]
        .filter(Boolean)
        .join(" ");
      byId.set(nodeId, {
        id: nodeId,
        label,
        sourceTree: relativePath,
        tags,
        evidencePaths: extractEvidencePaths(node.evidence),
        searchableText,
        tokens: new Set(tokenize(searchableText)),
        nodeType: inferNodeType(node),
      });
    }
  }
  return { byId };
}

function phraseHitCount(text: string, keywords: string[]): number {
  if (!text) return 0;
  let hits = 0;
  for (const keyword of keywords) {
    const normalized = normalizeText(keyword);
    if (!normalized) continue;
    if (text.includes(normalized)) hits += 1;
  }
  return hits;
}

function tokenOverlapCount(left: Set<string>, right: Set<string>): number {
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap += 1;
  }
  return overlap;
}

function scoreRuleMatch(args: {
  textNormalized: string;
  textTokens: Set<string>;
  rule: CanonicalRule;
  node: CanonicalIndexNode;
}): number {
  const hits = phraseHitCount(args.textNormalized, args.rule.keywords);
  if (hits <= 0) return 0;
  const overlap = tokenOverlapCount(args.textTokens, args.node.tokens);
  const keywordScore = Math.min(0.36, hits * 0.12);
  const overlapScore = Math.min(0.18, overlap * 0.03);
  return Math.min(0.99, 0.45 + args.rule.priority + keywordScore + overlapScore);
}

function targetThreshold(targetType: CanonicalTargetType): number {
  if (targetType === "equation") return 0.64;
  if (targetType === "model") return 0.66;
  if (targetType === "system") return 0.64;
  return 0.62;
}

function buildMatchFromRule(args: {
  rule: CanonicalRule;
  node: CanonicalIndexNode;
  targetType: CanonicalTargetType;
  score: number;
}): CanonicalBindingMatch {
  return {
    canonicalId: args.rule.canonicalId,
    canonicalLabel: args.node.label,
    targetType: args.targetType,
    relation: args.rule.relation,
    score: args.score,
    sourceTree: args.node.sourceTree,
    evidencePaths: args.node.evidencePaths.slice(0, 8),
    nodeType: args.node.nodeType,
  };
}

function bestRuleMatch(
  text: string,
  targetType: CanonicalTargetType,
  index: CanonicalIndex,
): CanonicalBindingMatch | null {
  const normalized = normalizeText(text);
  if (!normalized) return null;
  const textTokens = new Set(tokenize(normalized));
  let best: CanonicalBindingMatch | null = null;
  for (const rule of CANONICAL_RULES) {
    if (!rule.targetTypes.includes(targetType)) continue;
    const node = index.byId.get(rule.canonicalId);
    if (!node) continue;
    const score = scoreRuleMatch({
      textNormalized: normalized,
      textTokens,
      rule,
      node,
    });
    if (score < targetThreshold(targetType)) continue;
    if (!best || score > best.score) {
      best = buildMatchFromRule({ rule, node, targetType, score });
    }
  }
  return best;
}

export async function resolveCanonicalFrameworkBindings(
  input: CanonicalBindingInput,
  repoRoot = process.cwd(),
): Promise<{ bindings: CanonicalBindingSet; nodesById: Map<string, CanonicalNodeDescriptor> }> {
  const index = await loadCanonicalIndex(repoRoot);
  const bindings: CanonicalBindingSet = {
    concept: {},
    system: {},
    equation: {},
    model: null,
  };

  for (const concept of input.concepts) {
    const conceptText = [concept.term, concept.definition ?? ""].filter(Boolean).join(" ");
    const fallbackText = [concept.term, concept.definition ?? "", input.title].filter(Boolean).join(" ");
    const match =
      bestRuleMatch(conceptText, "concept", index) ??
      (fallbackText === conceptText ? null : bestRuleMatch(fallbackText, "concept", index));
    if (match) bindings.concept[concept.concept_id] = match;
  }

  for (const system of input.systems) {
    const text = [
      system.name,
      system.components.join(" "),
      system.interactions.join(" "),
      input.title,
      input.extractionText.slice(0, 800),
    ]
      .filter(Boolean)
      .join(" ");
    const match = bestRuleMatch(text, "system", index);
    if (match) bindings.system[system.system_id] = match;
  }

  for (const equation of input.equations) {
    const text = [equation.canonical_form, input.title, ...input.claimTexts.slice(0, 2)].filter(Boolean).join(" ");
    const match = bestRuleMatch(text, "equation", index);
    if (match) bindings.equation[equation.equation_id] = match;
  }

  const modelText = [input.title, ...input.claimTexts.slice(0, 6), input.extractionText.slice(0, 1600)]
    .filter(Boolean)
    .join(" ");
  bindings.model = bestRuleMatch(modelText, "model", index);
  return { bindings, nodesById: index.byId };
}

export function collectCanonicalBindingMatches(bindings: CanonicalBindingSet): CanonicalBindingMatch[] {
  const byId = new Map<string, CanonicalBindingMatch>();
  const register = (match: CanonicalBindingMatch | null | undefined): void => {
    if (!match) return;
    const existing = byId.get(match.canonicalId);
    if (!existing || match.score > existing.score) {
      byId.set(match.canonicalId, match);
    }
  };
  for (const match of Object.values(bindings.concept)) register(match);
  for (const match of Object.values(bindings.system)) register(match);
  for (const match of Object.values(bindings.equation)) register(match);
  register(bindings.model);
  return Array.from(byId.values()).sort((a, b) => b.score - a.score || a.canonicalId.localeCompare(b.canonicalId));
}
