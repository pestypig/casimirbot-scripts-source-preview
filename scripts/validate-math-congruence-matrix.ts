import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildMathCongruenceMatrix, type MathCongruenceMatrix } from "./build-math-congruence-matrix";

type ValidationResult = {
  ok: boolean;
  errors: string[];
};

type Root = { id?: unknown; equation_refs?: unknown };
type Equation = { id?: unknown };

const REQUIRED_SCHEMA = "math_congruence_matrix/1";

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function validateMathCongruenceMatrix(options?: {
  repoRoot?: string;
  matrixPath?: string;
}): ValidationResult {
  const repoRoot = path.resolve(options?.repoRoot ?? process.cwd());
  const matrixPath = path.resolve(
    repoRoot,
    options?.matrixPath ?? path.join("configs", "math-congruence-matrix.v1.json"),
  );
  const errors: string[] = [];

  if (!fs.existsSync(matrixPath)) {
    return { ok: false, errors: [`matrix not found: ${path.relative(repoRoot, matrixPath)}`] };
  }

  let matrix: MathCongruenceMatrix;
  try {
    matrix = readJson<MathCongruenceMatrix>(matrixPath);
  } catch (error) {
    return { ok: false, errors: [`invalid matrix JSON: ${String(error)}`] };
  }

  if (matrix.schema_version !== REQUIRED_SCHEMA) {
    errors.push(`schema_version must be ${REQUIRED_SCHEMA}`);
  }

  if (!Array.isArray(matrix.rows) || matrix.rows.length === 0) {
    errors.push("rows must contain at least one entry");
  }

  const pairSet = new Set<string>();
  const idSet = new Set<string>();

  (matrix.rows ?? []).forEach((row, index) => {
    const loc = `rows[${index}]`;
    const rowId = asString(row.id);
    const rootId = asString(row.root_id);
    const equationId = asString(row.equation_id);

    if (!rowId) {
      errors.push(`${loc}.id is required`);
    } else if (idSet.has(rowId)) {
      errors.push(`${loc}.id duplicated: ${rowId}`);
    } else {
      idSet.add(rowId);
    }

    if (!rootId) {
      errors.push(`${loc}.root_id is required`);
    }
    if (!equationId) {
      errors.push(`${loc}.equation_id is required`);
    }

    const pairKey = `${rootId}::${equationId}`;
    if (rootId && equationId) {
      if (pairSet.has(pairKey)) {
        errors.push(`${loc} duplicated root/equation pair: ${pairKey}`);
      }
      pairSet.add(pairKey);
    }

    if (!isRecord(row.binding)) {
      errors.push(`${loc}.binding is required`);
    } else {
      if (!asString(row.binding.lhs)) {
        errors.push(`${loc}.binding.lhs is required`);
      }
      if (!asString(row.binding.rhs)) {
        errors.push(`${loc}.binding.rhs is required`);
      }
      if (!asString(row.binding.operator)) {
        errors.push(`${loc}.binding.operator is required`);
      }
    }

    if (!isRecord(row.residual)) {
      errors.push(`${loc}.residual is required`);
    } else {
      if (!asString(row.residual.metric)) {
        errors.push(`${loc}.residual.metric is required`);
      }
      if (!asString(row.residual.comparator)) {
        errors.push(`${loc}.residual.comparator is required`);
      }
      if (!asString(row.residual.threshold)) {
        errors.push(`${loc}.residual.threshold is required`);
      }
    }

    if (!isRecord(row.falsifier)) {
      errors.push(`${loc}.falsifier is required`);
    } else {
      if (!asString(row.falsifier.condition)) {
        errors.push(`${loc}.falsifier.condition is required`);
      }
      if (!asString(row.falsifier.evidence)) {
        errors.push(`${loc}.falsifier.evidence is required`);
      }
    }
  });

  const rootLeaf = readJson<{ roots?: Root[] }>(
    path.join(repoRoot, "configs", "physics-root-leaf-manifest.v1.json"),
  );
  const backbone = readJson<{ equations?: Equation[] }>(
    path.join(repoRoot, "configs", "physics-equation-backbone.v1.json"),
  );

  const equationIds = new Set((backbone.equations ?? []).map((entry) => asString(entry.id)).filter(Boolean));

  for (const root of rootLeaf.roots ?? []) {
    const rootId = asString(root.id);
    if (!rootId) {
      continue;
    }
    const refs = Array.isArray(root.equation_refs)
      ? root.equation_refs.map((entry) => asString(entry)).filter(Boolean)
      : [];

    for (const equationId of refs) {
      if (!equationIds.has(equationId)) {
        errors.push(`root ${rootId} references unknown equation: ${equationId}`);
        continue;
      }
      const pair = `${rootId}::${equationId}`;
      if (!pairSet.has(pair)) {
        errors.push(`missing matrix row for root/equation pair: ${pair}`);
      }
    }
  }

  const expected = buildMathCongruenceMatrix({ repoRoot });
  if (JSON.stringify(expected) !== JSON.stringify(matrix)) {
    errors.push("matrix must exactly match deterministic builder output (run tsx scripts/build-math-congruence-matrix.ts)");
  }

  return { ok: errors.length === 0, errors };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  const result = validateMathCongruenceMatrix();
  if (!result.ok) {
    console.error("math congruence matrix validation FAILED");
    for (const err of result.errors) {
      console.error(` - ${err}`);
    }
    process.exit(1);
  }
  console.log("math congruence matrix validation PASS");
}
