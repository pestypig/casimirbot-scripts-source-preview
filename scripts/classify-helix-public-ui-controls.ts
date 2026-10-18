import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

import {
  buildHelixPublicUiControlInventory,
  type PublicUiControlInventoryEntry,
} from "./lib/helix-public-ui-control-inventory";
import type { HelixPublicUiInteractionKind } from "../shared/helix-public-ui-affordance";

const repoRoot = path.resolve(process.cwd());
const writeChanges = process.argv.includes("--write");

const ACT_PATTERN = /(?:^|[.-])(?:apply|approve|archive|attach|bind-objective|cancel|capture|claim|clear|connect|confirm|continue|copy|create|delete|detach|disconnect|emergency|emit|execute|explain-result|export|generate|import|join|kill|launch|leave|new-note|on-load-fruition|pair|paste|place|prepare|print|process|publish|reject|remove|request|reset|restart|retry|revoke|run|save|send|share-reads|sign-out|solve|speak|stage|start|stop|submit|use-the|write)(?:[.-]|$)/;
const OBSERVE_PATTERN = /(?:^|[.-])(?:check|inspect|load-board|read|reconcile|refresh|reload|status|verify|view-debug|view-receipt)(?:[.-]|$)/;
const CONFIGURE_PATTERN = /(?:^|[.-])(?:arm|authority|blank-placeholder|choose|consent|current-chat|custom-topic|disable|dispatch-scientific|edit|enable|file-input|filter|grant|lifecycle|load-scalar|load-theory-loadout|microphone|mode|on-load-payload|pause|pin|preference|promote|rate|rebase|release-speaking-floor|resume|select|set|sort|take-floor|toggle|use-as-context|use-full-image)(?:[.-]|$)/;
const NAVIGATE_PATTERN = /(?:^|[.-])(?:advanced-fallback|back|close|collapse|directory|dismiss|doc-math|expand|focus|forward|go-home|hide|history|home|next|open|overlay|previous|realtime-texture-pack|scroll|shared-live-rooms|show|switcher|tab|view-doc|view-mode|x)(?:[.-]|$)/;

export const classifyHelixPublicUiControl = (
  entry: PublicUiControlInventoryEntry,
): HelixPublicUiInteractionKind => {
  // Explicit human-consent boundaries are semantic policy, not mechanical
  // defaults. A verb such as "bind" or "revoke" must not silently turn a
  // user-only decision into an agent-classified action during catalog audits.
  if (
    entry.interaction_classification_source === "explicit" &&
    entry.interaction_kind === "human_only"
  ) return "human_only";
  if (
    entry.locator ===
    "workstation.panel.agent-access.agent-connection-setup.reasoning-claim-handle"
  ) return "observe";
  if (["input", "select", "textarea", "Input", "Textarea", "Checkbox", "Switch", "Slider", "SelectTrigger"].includes(entry.element)) return "configure";
  if (["TabsTrigger", "DropdownMenuItem", "CommandItem"].includes(entry.element)) return "navigate";
  if (entry.element === "form") return "act";
  const identity = entry.locator.toLowerCase();
  if (identity === "helix.ask.helix-ask-slash-command-menu.button") return "configure";
  if (identity === "workstation.shell.workstation-panel-tabs.button") return "navigate";
  if (entry.source_path.endsWith("MoralGraphPanel.tsx") && identity.includes(".button")) return "navigate";
  if (entry.source_path.endsWith("TheoryAchievementMap.tsx")) return "navigate";
  if (identity.includes("moral-graph-biome-map")) return "navigate";
  if (identity.endsWith("theory-atlas-rail.there4")) return "navigate";
  if (ACT_PATTERN.test(identity)) return "act";
  if (OBSERVE_PATTERN.test(identity)) return "observe";
  if (CONFIGURE_PATTERN.test(identity)) return "configure";
  if (NAVIGATE_PATTERN.test(identity)) return "navigate";
  return entry.interaction_kind;
};

const inventory = buildHelixPublicUiControlInventory(repoRoot);
const candidates = inventory
  .map((entry) => ({ entry, next: classifyHelixPublicUiControl(entry) }))
  .filter(({ entry, next }) => next !== entry.interaction_kind);
const candidatesByPath = new Map<string, typeof candidates>();
for (const candidate of candidates) {
  const rows = candidatesByPath.get(candidate.entry.source_path) ?? [];
  rows.push(candidate);
  candidatesByPath.set(candidate.entry.source_path, rows);
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
    rows.map((row) => [`${row.entry.line}:${row.entry.element}`, row]),
  );
  const edits: Array<{ start: number; end: number; text: string }> = [];
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
        const attribute = opening.attributes.properties.find(
          (candidate): candidate is ts.JsxAttribute =>
            ts.isJsxAttribute(candidate) &&
            candidate.name.getText() === "data-helix-interaction-kind",
        );
        if (attribute?.initializer && ts.isStringLiteral(attribute.initializer)) {
          edits.push({
            start: attribute.initializer.getStart() + 1,
            end: attribute.initializer.getEnd() - 1,
            text: row.next,
          });
          rowByLineAndElement.delete(`${line}:${tagName}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  unresolvedControlIds.push(
    ...[...rowByLineAndElement.values()].map((row) => row.entry.control_id),
  );
  if (edits.length === 0) continue;
  let nextSource = sourceText;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    nextSource = `${nextSource.slice(0, edit.start)}${edit.text}${nextSource.slice(edit.end)}`;
  }
  changedFiles.push(sourcePath);
  if (writeChanges) fs.writeFileSync(absolutePath, nextSource, "utf8");
}

const nextCounts = inventory.reduce<Record<string, number>>((counts, entry) => {
  const next = classifyHelixPublicUiControl(entry);
  counts[next] = (counts[next] ?? 0) + 1;
  return counts;
}, {});
const remainingHumanOnly = inventory
  .filter((entry) => classifyHelixPublicUiControl(entry) === "human_only")
  .map((entry) => entry.locator);

const result = {
  schema: "helix.public_ui_control_classification.v1",
  mode: writeChanges ? "write" : "check",
  candidate_control_count: candidates.length,
  changed_file_count: changedFiles.length,
  changed_files: changedFiles,
  next_counts: nextCounts,
  remaining_human_only_count: remainingHumanOnly.length,
  remaining_human_only_control_ids: remainingHumanOnly,
  unresolved_control_ids: unresolvedControlIds,
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (unresolvedControlIds.length > 0) process.exitCode = 1;
