import path from "node:path";
import { fileURLToPath } from "node:url";

export type SlicePathBoundsInput = {
  changedPaths: string[];
  allowedPaths: string[];
};

export type SlicePathViolation = {
  path: string;
  reason: "outside_allowlist";
};

export type SlicePathBoundsResult = {
  ok: boolean;
  violations: SlicePathViolation[];
};

const normalize = (value: string): string => {
  const normalized = value.replace(/\\+/g, "/").trim().replace(/^\.\//, "");
  const posix = path.posix.normalize(normalized);
  if (posix === ".") return "";
  return posix.replace(/\/$/, "");
};

const isAllowed = (targetPath: string, allowEntry: string): boolean => {
  if (allowEntry.endsWith("/*")) {
    const base = allowEntry.slice(0, -2);
    return targetPath === base || targetPath.startsWith(`${base}/`);
  }
  return targetPath === allowEntry || targetPath.startsWith(`${allowEntry}/`);
};

export function evaluateSlicePathBounds(input: SlicePathBoundsInput): SlicePathBoundsResult {
  const allowed = input.allowedPaths.map(normalize).filter(Boolean);
  const changed = input.changedPaths.map(normalize).filter(Boolean);

  const violations: SlicePathViolation[] = [];
  for (const entry of changed) {
    const accepted = allowed.some((allowEntry) => isAllowed(entry, allowEntry));
    if (!accepted) {
      violations.push({ path: entry, reason: "outside_allowlist" });
    }
  }

  return {
    ok: violations.length === 0,
    violations,
  };
}

export function isCliEntrypoint(argv = process.argv): boolean {
  const argvPath = argv[1];
  if (!argvPath) {
    return false;
  }

  const scriptPath = fileURLToPath(import.meta.url);
  const resolvedArgvPath = path.resolve(argvPath);
  return path.normalize(resolvedArgvPath) === path.normalize(scriptPath);
}

if (isCliEntrypoint()) {
  const changedArg = process.argv[2] ?? "";
  const allowArg = process.argv[3] ?? "";
  const changedPaths = changedArg.split(",").map((entry) => entry.trim()).filter(Boolean);
  const allowedPaths = allowArg.split(",").map((entry) => entry.trim()).filter(Boolean);
  const result = evaluateSlicePathBounds({ changedPaths, allowedPaths });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.ok ? 0 : 2);
}
