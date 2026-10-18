import path from "node:path";
import { enforceResearchCitationGate } from "./lib/research-citation-gate";

const readArgValue = (flag: string, argv: string[]): string | undefined => {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  return argv[index + 1];
};

const parseBooleanArg = (value: string | undefined, fallback: boolean): boolean => {
  if (value == null) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
};

const argv = process.argv.slice(2);
const checklistPath =
  readArgValue("--checklist", argv) ??
  path.join("docs", "research", "research-citation-patch-checklist.v1.json");

try {
  const summary = enforceResearchCitationGate({
    manifestPath: checklistPath,
    requireGithubCloneForMeasured: parseBooleanArg(
      readArgValue("--require-github-clone-for-measured", argv),
      false,
    ),
    requireCompletedChecklistItems: parseBooleanArg(
      readArgValue("--require-complete-checklist", argv),
      true,
    ),
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        gate: "research_citation_patch_checklist/v1",
        summary,
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[research-citation-gate] ${detail}\n`);
  process.exitCode = 1;
}
