import fs from "node:fs";
import path from "node:path";

type SymbolEntry = {
  symbol?: string;
  quantity?: string;
  units?: string;
};

type EquationEntry = {
  id?: string;
  name?: string;
  expression?: string;
  claim_tier?: string;
  symbols?: SymbolEntry[];
};

type PhysicsEquationBackboneManifest = {
  schema_version?: string;
  manifest_id?: string;
  unit_system?: string;
  claim_tier?: string;
  equations?: EquationEntry[];
};

export type ValidationResult = {
  ok: boolean;
  errors: string[];
};

const REQUIRED_SCHEMA = "physics_equation_backbone/1";
const ALLOWED_CLAIM_TIERS = new Set(["diagnostic", "reduced-order", "certified"]);
const REQUIRED_EQUATIONS: Array<{
  id: string;
  requiredSymbols: string[];
  requiredUnits: string[];
}> = [
  {
    id: "efe_baseline",
    requiredSymbols: ["G_mu_nu", "Lambda", "g_mu_nu", "G", "c", "T_mu_nu"],
    requiredUnits: ["1/m^2", "m^3/(kg*s^2)", "m/s", "Pa"],
  },
  {
    id: "semiclassical_coupling",
    requiredSymbols: ["G_mu_nu", "Lambda", "g_mu_nu", "<T_mu_nu>"],
    requiredUnits: ["1/m^2", "Pa"],
  },
  {
    id: "stress_energy_conservation",
    requiredSymbols: ["nabla_mu", "T_mu_nu"],
    requiredUnits: ["1/m", "Pa"],
  },
  {
    id: "uncertainty_propagation",
    requiredSymbols: ["sigma_f", "partial f / partial x_i", "sigma_x_i"],
    requiredUnits: ["output_units", "output_units/input_units", "input_units"],
  },
  {
    id: "runtime_safety_gate",
    requiredSymbols: ["delta_T00", "T00_ref", "eps", "rho_delta_max", "qi_bound_ok"],
    requiredUnits: ["J/m^3", "dimensionless", "boolean"],
  },
  {
    id: "curvature_unit_proxy_contract",
    requiredSymbols: ["kappa_proxy", "curvature_signal", "scale_assumptions", "kappa_ref", "eps"],
    requiredUnits: ["1/m^2", "arb_curvature_units", "dimensionless"],
  },
];

function parseArgs(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0 || index + 1 >= process.argv.length) {
    return undefined;
  }
  return process.argv[index + 1];
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function normalizeSet(values: string[]): Set<string> {
  return new Set(values.map((value) => value.trim()).filter((value) => value.length > 0));
}

export function validatePhysicsEquationBackbone(options?: {
  manifestPath?: string;
  repoRoot?: string;
}): ValidationResult {
  const repoRoot = path.resolve(options?.repoRoot ?? process.cwd());
  const manifestPath = path.resolve(
    repoRoot,
    options?.manifestPath ?? path.join("configs", "physics-equation-backbone.v1.json"),
  );

  if (!fs.existsSync(manifestPath)) {
    return { ok: false, errors: [`manifest not found: ${path.relative(repoRoot, manifestPath)}`] };
  }

  let manifest: PhysicsEquationBackboneManifest;
  try {
    manifest = readJson<PhysicsEquationBackboneManifest>(manifestPath);
  } catch (error) {
    return { ok: false, errors: [`invalid manifest JSON: ${String(error)}`] };
  }

  const errors: string[] = [];

  if (manifest.schema_version !== REQUIRED_SCHEMA) {
    errors.push(`schema_version must be ${REQUIRED_SCHEMA}`);
  }

  const manifestClaimTier = typeof manifest.claim_tier === "string" ? manifest.claim_tier.trim() : "";
  if (!ALLOWED_CLAIM_TIERS.has(manifestClaimTier)) {
    errors.push(`claim_tier must be one of ${Array.from(ALLOWED_CLAIM_TIERS).join("|")}`);
  }

  const equations = Array.isArray(manifest.equations) ? manifest.equations : [];
  if (equations.length === 0) {
    errors.push("equations must contain at least one entry");
    return { ok: false, errors };
  }

  const byId = new Map<string, EquationEntry>();
  equations.forEach((equation, index) => {
    const id = typeof equation.id === "string" ? equation.id.trim() : "";
    const location = `equations[${index}]`;
    if (!id) {
      errors.push(`${location}.id is required`);
      return;
    }
    if (byId.has(id)) {
      errors.push(`${location}.id duplicated: ${id}`);
      return;
    }
    byId.set(id, equation);

    const expression = typeof equation.expression === "string" ? equation.expression.trim() : "";
    if (!expression) {
      errors.push(`${location}.expression is required`);
    }

    const claimTier = typeof equation.claim_tier === "string" ? equation.claim_tier.trim() : "";
    if (!ALLOWED_CLAIM_TIERS.has(claimTier)) {
      errors.push(`${location}.claim_tier must be one of ${Array.from(ALLOWED_CLAIM_TIERS).join("|")}`);
    }

    const symbols = Array.isArray(equation.symbols) ? equation.symbols : [];
    if (symbols.length === 0) {
      errors.push(`${location}.symbols must contain at least one symbol`);
    }
  });

  for (const requiredEquation of REQUIRED_EQUATIONS) {
    const equation = byId.get(requiredEquation.id);
    if (!equation) {
      errors.push(`missing required equation id: ${requiredEquation.id}`);
      continue;
    }

    const symbols = Array.isArray(equation.symbols) ? equation.symbols : [];
    const symbolSet = normalizeSet(
      symbols.map((entry) => (typeof entry.symbol === "string" ? entry.symbol : "")),
    );
    const unitSet = normalizeSet(
      symbols.map((entry) => (typeof entry.units === "string" ? entry.units : "")),
    );

    for (const requiredSymbol of requiredEquation.requiredSymbols) {
      if (!symbolSet.has(requiredSymbol)) {
        errors.push(`equation ${requiredEquation.id} missing required symbol: ${requiredSymbol}`);
      }
    }

    for (const requiredUnit of requiredEquation.requiredUnits) {
      if (!unitSet.has(requiredUnit)) {
        errors.push(`equation ${requiredEquation.id} missing required unit: ${requiredUnit}`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

function main() {
  const manifestPath = parseArgs("--manifest");
  const result = validatePhysicsEquationBackbone({ manifestPath });

  if (!result.ok) {
    console.error("physics-equation-backbone validation failed:");
    for (const error of result.errors) {
      console.error(`- ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("physics-equation-backbone validation OK");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
