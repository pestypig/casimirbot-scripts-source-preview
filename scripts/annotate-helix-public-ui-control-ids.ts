import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

import {
  buildHelixPublicUiControlInventory,
  type PublicUiControlInventoryEntry,
} from "./lib/helix-public-ui-control-inventory";

const repoRoot = path.resolve(process.cwd());
const writeChanges = process.argv.includes("--write");
const domBackedElementPattern = /^(?:[a-z][a-z0-9-]*|Button|Checkbox|CommandItem|DropdownMenuItem|Input|SelectTrigger|Slider|Switch|TabsTrigger|Textarea)$/;

const slug = (value: string): string =>
  value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72)
    .replace(/-+$/g, "");

const componentSlug = (sourcePath: string): string =>
  slug(path.basename(sourcePath, path.extname(sourcePath)));

export const buildGeneratedHelixControlIds = (
  rows: readonly PublicUiControlInventoryEntry[],
): Map<string, string> => {
  const generated = new Map<string, string>();
  const seen = new Map<string, number>();
  for (const row of [...rows].sort((left, right) =>
    left.source_path.localeCompare(right.source_path) || left.line - right.line,
  )) {
    const locatorSlug = row.locator_kind === "line"
      ? slug(row.element)
      : slug(row.locator) || slug(row.element);
    const base = `${row.surface_id}.${componentSlug(row.source_path)}.${locatorSlug}`;
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    generated.set(row.control_id, occurrence === 1 ? base : `${base}.${occurrence}`);
  }
  return generated;
};

const inventory = buildHelixPublicUiControlInventory(repoRoot);
const candidates = inventory.filter(
  (entry) =>
    domBackedElementPattern.test(entry.element) &&
    (
      entry.locator_kind !== "helix_control_id" ||
      entry.interaction_classification_source !== "explicit" ||
      entry.authority_classification_source === "surface_default"
    ),
);
const idCandidates = candidates.filter((entry) => entry.locator_kind !== "helix_control_id");
const generatedIds = buildGeneratedHelixControlIds(idCandidates);
const existingIds = new Set(
  inventory
    .filter((entry) => entry.locator_kind === "helix_control_id")
    .map((entry) => entry.locator),
);
const candidatesByPath = new Map<string, PublicUiControlInventoryEntry[]>();
for (const candidate of candidates) {
  const rows = candidatesByPath.get(candidate.source_path) ?? [];
  rows.push(candidate);
  candidatesByPath.set(candidate.source_path, rows);
}

const changedFiles: string[] = [];
const unresolvedControlIds: string[] = [];
for (const [sourcePath, rows] of [...candidatesByPath.entries()].sort(([left], [right]) =>
  left.localeCompare(right),
)) {
  const absolutePath = path.resolve(repoRoot, sourcePath);
  const sourceText = fs.readFileSync(absolutePath, "utf8");
  const sourceFile = ts.createSourceFile(
    absolutePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const rowByLineAndElement = new Map(
    rows.map((row) => [`${row.line}:${row.element}`, row]),
  );
  const edits: Array<{ position: number; text: string; control_id: string }> = [];
  const visit = (node: ts.Node): void => {
    const opening = ts.isJsxElement(node)
      ? node.openingElement
      : ts.isJsxSelfClosingElement(node)
        ? node
        : undefined;
    if (opening) {
      const line = sourceFile.getLineAndCharacterOfPosition(opening.getStart()).line + 1;
      const tagName = opening.tagName.getText();
      const row = rowByLineAndElement.get(`${line}:${tagName}`);
      if (row) {
        const additions: string[] = [];
        if (row.locator_kind !== "helix_control_id") {
          const generatedId = generatedIds.get(row.control_id);
          if (!generatedId) {
            unresolvedControlIds.push(row.control_id);
          } else {
            additions.push(`data-helix-control-id="${generatedId}"`);
          }
        }
        if (row.interaction_classification_source !== "explicit") {
          additions.push(`data-helix-interaction-kind="${row.interaction_kind}"`);
        }
        if (row.authority_classification_source === "surface_default") {
          additions.push(`data-helix-authority-state="${row.authority_state}"`);
        }
        if (additions.length > 0) {
          edits.push({
            position: opening.tagName.end,
            text: ` ${additions.join(" ")}`,
            control_id: row.control_id,
          });
        }
        rowByLineAndElement.delete(`${line}:${tagName}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  unresolvedControlIds.push(...[...rowByLineAndElement.values()].map((row) => row.control_id));
  if (edits.length === 0) continue;
  let nextSource = sourceText;
  for (const edit of edits.sort((left, right) => right.position - left.position)) {
    nextSource = `${nextSource.slice(0, edit.position)}${edit.text}${nextSource.slice(edit.position)}`;
  }
  changedFiles.push(sourcePath);
  if (writeChanges) fs.writeFileSync(absolutePath, nextSource, "utf8");
}

const duplicateGeneratedIds = [...generatedIds.values()].filter(
  (controlId, index, all) => all.indexOf(controlId) !== index,
);
const generatedIdCollisions = [...generatedIds.values()].filter((controlId) => existingIds.has(controlId));
const result = {
  schema: "helix.public_ui_control_id_annotation.v1",
  mode: writeChanges ? "write" : "check",
  candidate_control_count: candidates.length,
  generated_control_id_count: idCandidates.length,
  changed_file_count: changedFiles.length,
  changed_files: changedFiles,
  unresolved_control_ids: unresolvedControlIds,
  duplicate_generated_ids: [...new Set(duplicateGeneratedIds)],
  existing_id_collisions: [...new Set(generatedIdCollisions)],
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (
  unresolvedControlIds.length > 0 ||
  duplicateGeneratedIds.length > 0 ||
  generatedIdCollisions.length > 0
) process.exitCode = 1;
