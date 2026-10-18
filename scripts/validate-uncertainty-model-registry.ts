import fs from "node:fs";
import path from "node:path";

export type ValidationResult = {
  ok: boolean;
  errors: string[];
};

type RegistryModel = {
  id?: string;
  description?: string;
  required_parameters?: string[];
  optional_parameters?: string[];
};

type Registry = {
  schema_version?: string;
  registry_id?: string;
  models?: RegistryModel[];
};

const REQUIRED_SCHEMA = "uncertainty_model_registry/1";

function parseFlag(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0 || index + 1 >= process.argv.length) {
    return undefined;
  }
  return process.argv[index + 1];
}

function normalizeList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

export function validateUncertaintyModelRegistry(options?: {
  repoRoot?: string;
  registryPath?: string;
}): ValidationResult {
  const repoRoot = path.resolve(options?.repoRoot ?? process.cwd());
  const registryPath = path.resolve(
    repoRoot,
    options?.registryPath ?? path.join("configs", "uncertainty-model-registry.v1.json"),
  );

  if (!fs.existsSync(registryPath)) {
    return { ok: false, errors: [`registry not found: ${path.relative(repoRoot, registryPath)}`] };
  }

  let registry: Registry;
  try {
    registry = readJson<Registry>(registryPath);
  } catch (error) {
    return { ok: false, errors: [`invalid registry JSON: ${String(error)}`] };
  }

  const errors: string[] = [];
  if (registry.schema_version !== REQUIRED_SCHEMA) {
    errors.push(`schema_version must be ${REQUIRED_SCHEMA}`);
  }
  if (typeof registry.registry_id !== "string" || registry.registry_id.trim().length === 0) {
    errors.push("registry_id is required");
  }

  const models = Array.isArray(registry.models) ? registry.models : [];
  if (models.length === 0) {
    errors.push("models must contain at least one entry");
  }

  const ids = new Set<string>();
  models.forEach((model, index) => {
    const loc = `models[${index}]`;
    const id = typeof model.id === "string" ? model.id.trim() : "";
    if (!id) {
      errors.push(`${loc}.id is required`);
    } else if (ids.has(id)) {
      errors.push(`${loc}.id duplicated: ${id}`);
    } else {
      ids.add(id);
    }

    if (typeof model.description !== "string" || model.description.trim().length === 0) {
      errors.push(`${loc}.description is required`);
    }

    const requiredParameters = normalizeList(model.required_parameters);
    if (requiredParameters.length === 0) {
      errors.push(`${loc}.required_parameters must be non-empty`);
    }

    const optionalParameters = normalizeList(model.optional_parameters);
    const all = [...requiredParameters, ...optionalParameters];
    const seen = new Set<string>();
    for (const parameter of all) {
      if (seen.has(parameter)) {
        errors.push(`${loc} parameter duplicated: ${parameter}`);
      }
      seen.add(parameter);
    }
  });

  return { ok: errors.length === 0, errors };
}

function main() {
  const registryPath = parseFlag("--registry");
  const result = validateUncertaintyModelRegistry({ registryPath });

  if (!result.ok) {
    console.error("uncertainty-model-registry validation failed:");
    for (const error of result.errors) {
      console.error(`- ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("uncertainty-model-registry validation OK");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
