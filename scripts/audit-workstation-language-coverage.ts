import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { INTERFACE_MESSAGE_IDS } from "../client/src/lib/i18n/messages/types";
import { buildNhm2TheoryBadgeGraphV1 } from "../shared/theory/nhm2-theory-badges";
import { buildHelixPhysicsAtlasV1 } from "../shared/theory/physics-atlas-blocks";
import { STARSIM_STELLAR_EVOLUTION_STAGES } from "../shared/theory/starsim-stellar-evolution-map";
import { COSMIC_DISTANCE_LADDER_RUNGS } from "../shared/theory/cosmic-distance-ladder-map";
import { SOLAR_SPECTRUM_OBSERVATION_GROUPS } from "../shared/theory/solar-spectrum-observation-map";
import { CASIMIR_CAVITY_GROUPS } from "../shared/theory/casimir-cavity-map";
import { WARP_GR_NHM2_GROUPS } from "../shared/theory/warp-gr-nhm2-map";
import { QEI_STRESS_ENERGY_GROUPS } from "../shared/theory/qei-stress-energy-map";
import { TOKAMAK_PLASMA_GROUPS } from "../shared/theory/tokamak-plasma-map";
import { GALACTIC_DYNAMICS_GROUPS } from "../shared/theory/galactic-dynamics-map";
import { CURVATURE_COLLAPSE_GROUPS } from "../shared/theory/curvature-collapse-map";
import { MORAL_LIVING_SUBSTRATE_PRINCIPLES } from "../shared/moral-graph/living-substrate-principles";
import { MORAL_WISDOM_PRINCIPLES } from "../shared/moral-graph/wisdom-principles";

type PanelAuditTarget = {
  panelId: string;
  label: string;
  files: string[];
  dynamicContentRefs?: string[];
};

type HardcodedTextFinding = {
  file: string;
  line: number;
  column: number;
  surface: string;
  text: string;
  classification: "unresolved_static_ui" | "deferred_developer_or_symbol";
};

type SharedDataTextFinding = {
  source: string;
  field: string;
  text: string;
};

type PanelCoverageReport = {
  panelId: string;
  label: string;
  files: string[];
  catalogCoveredStaticRefs: string[];
  dynamicTranslatableRefs: string[];
  unresolvedStaticUi: HardcodedTextFinding[];
  deferredDeveloperOrSymbol: HardcodedTextFinding[];
  uncatalogedSharedData: SharedDataTextFinding[];
};

const repoRoot = process.cwd();
const interfaceMessageIdSet = new Set<string>(INTERFACE_MESSAGE_IDS);

const auditTargets: PanelAuditTarget[] = [
  {
    panelId: "workstation-shell",
    label: "Workstation shell, tabs, and host",
    files: [
      "client/src/components/workstation/HelixWorkstationShell.tsx",
      "client/src/components/workstation/WorkstationPanelTabs.tsx",
      "client/src/components/workstation/WorkstationPanelHost.tsx",
      "client/src/pages/mobile-start.tsx",
    ],
  },
  {
    panelId: "account-session",
    label: "Account & Sessions",
    files: ["client/src/components/workstation/AccountSessionPanel.tsx"],
  },
  {
    panelId: "docs-viewer",
    label: "Docs & Papers",
    files: ["client/src/components/DocViewerPanel.tsx"],
    dynamicContentRefs: [
      "active document title/path",
      "visible document paragraphs",
      "selected document text",
      "document translation chunks",
    ],
  },
  {
    panelId: "situation-room",
    label: "Situation Room",
    files: ["client/src/components/workstation/SituationRoomPipelinesPanel.tsx"],
    dynamicContentRefs: [
      "pipeline job labels",
      "source excerpts",
      "translation output blocks",
      "external observation summaries",
    ],
  },
  {
    panelId: "theory-badge-graph",
    label: "Theory Badge Graph",
    files: ["client/src/components/panels/TheoryBadgeGraphPanel.tsx"],
    dynamicContentRefs: [
      "badge.title",
      "badge.plainMeaning",
      "edge.label",
      "equation.expression",
      "payload.label",
      "source.title",
      "atlas lens and preset data",
      "reflection and playback observations",
    ],
  },
  {
    panelId: "moral-graph",
    label: "Moral Badge Graph",
    files: [
      "client/src/components/panels/MoralGraphLaunchPanel.tsx",
      "client/src/components/panels/MoralGraphPanel.tsx",
      "client/src/components/panels/moral-graph/MoralGraphBiomeMap.tsx",
      "client/src/components/panels/moral-graph/MoralGraphCellWatermarks.tsx",
    ],
    dynamicContentRefs: [
      "runtime reflection moral badge labels",
      "runtime reflection moral badge summaries",
      "hovered node procedural expressions",
      "character comparison hypotheses",
      "current answer evidence blocks",
      "recommended action labels and effects",
    ],
  },
  {
    panelId: "scientific-calculator",
    label: "Scientific Calculator",
    files: ["client/src/components/panels/ScientificCalculatorPanel.tsx"],
    dynamicContentRefs: [
      "calculator expression input/output",
      "theory run payload values",
      "computed step explanations",
    ],
  },
  {
    panelId: "image-lens",
    label: "Image Lens",
    files: [
      "client/src/components/workstation/DocumentImageLensPanel.tsx",
      "client/src/components/workstation/ImageLensPanel.tsx",
    ],
    dynamicContentRefs: [
      "OCR text",
      "image region labels",
      "scientific evidence packet text",
      "source image metadata",
    ],
  },
];

const visibleStringAttributes = new Set([
  "aria-label",
  "alt",
  "label",
  "placeholder",
  "title",
]);

const ignoredAttributes = new Set([
  "className",
  "data-testid",
  "data-workstation-panel-id",
  "href",
  "id",
  "key",
  "role",
  "type",
]);

const developerOrSymbolPatterns = [
  /^[+\-x×*/=<>()[\]{}|.:,;!?_#%&\s]+$/,
  /^[-\s]*[a-zA-Z0-9_.:-]+\s*[:=]$/,
  /^[A-Z0-9_./:-]{2,}$/,
  /^\d+(?:\.\d+)?(?:\s*[a-zA-Z%/]+)?$/,
  /^[A-Za-z0-9_.:-]+\/v\d+$/,
  /^[A-Za-z0-9_.:-]+:[A-Za-z0-9_.:-]+$/,
  /^#[0-9a-fA-F]{3,8}$/,
];

function toRepoPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function fileExists(repoRelativePath: string): boolean {
  return fs.existsSync(path.join(repoRoot, repoRelativePath));
}

function lineAndColumn(sourceFile: ts.SourceFile, position: number): { line: number; column: number } {
  const location = sourceFile.getLineAndCharacterOfPosition(position);
  return { line: location.line + 1, column: location.character + 1 };
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isDeveloperOrSymbolText(text: string, surface: string): boolean {
  if (!/[A-Za-z]/.test(text)) return true;
  if (text.length <= 2) return true;
  if (ignoredAttributes.has(surface)) return true;
  return developerOrSymbolPatterns.some((pattern) => pattern.test(text));
}

function readAttributeName(name: ts.JsxAttributeName): string {
  return ts.isIdentifier(name) ? name.text : name.getText();
}

function collectCatalogRefs(text: string): string[] {
  const refs = new Set<string>();
  const patterns = [
    /\b(?:t|interfaceText\.t)\(\s*["']([^"']+)["']/g,
    /\bgetInterfacePanelTitle\(\s*[^,]+,\s*[^,]+,\s*[^)]*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      refs.add(match[1] ?? "panel-title-route");
    }
  }
  for (const match of text.matchAll(/["']([^"']+)["']/g)) {
    const candidate = match[1];
    if (interfaceMessageIdSet.has(candidate)) refs.add(candidate);
  }
  return Array.from(refs).sort();
}

function collectDynamicRefs(text: string, configuredRefs: string[] = []): string[] {
  const refs = new Set<string>(configuredRefs);
  const dynamicPatterns: Array<[RegExp, string]> = [
    [/\bbadge\.title\b/g, "badge.title"],
    [/\bbadge\.plainMeaning\b/g, "badge.plainMeaning"],
    [/\bedge\.label\b/g, "edge.label"],
    [/\bsource\.(?:title|url|kind)\b/g, "source metadata"],
    [/\b(?:translatedText|translationBlocks|activeTranslationBlocks)\b/g, "translation blocks"],
    [/\b(?:selectedText|hoveredText|visibleText)\b/g, "selected/hovered/visible text"],
    [/\b(?:calculatorResult|expression|computedValue)\b/g, "calculator values"],
    [/\b(?:ocr|recognizedText|evidencePacket)\b/gi, "OCR/evidence packet text"],
  ];
  for (const [pattern, label] of dynamicPatterns) {
    if (pattern.test(text)) refs.add(label);
  }
  return Array.from(refs).sort();
}

function extractStaticTextMap(repoRelativePath: string, constName: string): Map<string, string> {
  const filePath = path.join(repoRoot, repoRelativePath);
  if (!fs.existsSync(filePath)) return new Map();
  const text = fs.readFileSync(filePath, "utf8");
  const startNeedle = `const ${constName}`;
  const start = text.indexOf(startNeedle);
  if (start < 0) return new Map();
  const openBrace = text.indexOf("{", start);
  if (openBrace < 0) return new Map();
  let depth = 0;
  let end = openBrace;
  for (; end < text.length; end += 1) {
    const char = text[end];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const objectText = text.slice(openBrace, end + 1);
  const entries = new Map<string, string>();
  for (const match of objectText.matchAll(/"((?:\\.|[^"\\])*)"\s*:\s*"([^"]+)"/g)) {
    try {
      entries.set(JSON.parse(`"${match[1]}"`), match[2]);
    } catch {
      entries.set(match[1], match[2]);
    }
  }
  return entries;
}

const visibleSharedDataKeys = new Set([
  "title",
  "shortTitle",
  "label",
  "description",
  "plainMeaning",
  "whyItMatters",
  "summary",
  "note",
  "claimBoundaryNotes",
  "assumptions",
  "objectClass",
  "objectBindings",
  "runtimeActions",
  "actionEffect",
  "proceduralRule",
  "traceBehavior",
  "evidenceNeeds",
  "refusesAuthority",
  "tags",
]);

const sharedDataExcludedKeys = new Set([
  "id",
  "badgeId",
  "badgeIds",
  "sourceTheoryBadgeIds",
  "sourceIdeologyNodeId",
  "path",
  "repoPathHints",
  "sourceRefs",
  "symbols",
  "equationFamilies",
  "simulationOwners",
  "unitSignatures",
  "expression",
  "displayLatex",
  "glyph",
]);

function isTranslatableSharedDataText(text: string): boolean {
  const cleaned = cleanText(text);
  if (!cleaned || !/[A-Za-z]/.test(cleaned)) return false;
  if (isDeveloperOrSymbolText(cleaned, "shared-data")) return false;
  if (/[_{}=]/.test(cleaned)) return false;
  if (/^[a-z0-9_.:-]+$/i.test(cleaned) && cleaned.length < 24) return false;
  return true;
}

function addSharedDataText(
  target: SharedDataTextFinding[],
  seen: Set<string>,
  source: string,
  field: string,
  value: unknown,
) {
  if (typeof value !== "string") return;
  const text = cleanText(value);
  if (!isTranslatableSharedDataText(text)) return;
  const key = `${source}\u0000${field}\u0000${text}`;
  if (seen.has(key)) return;
  seen.add(key);
  target.push({ source, field, text });
}

function collectSharedDataTextFromValue(
  target: SharedDataTextFinding[],
  seen: Set<string>,
  source: string,
  value: unknown,
  field = "value",
) {
  if (typeof value === "string") {
    addSharedDataText(target, seen, source, field, value);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectSharedDataTextFromValue(target, seen, source, entry, `${field}[${index}]`));
    return;
  }
  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    if (sharedDataExcludedKeys.has(key)) continue;
    if (!visibleSharedDataKeys.has(key)) continue;
    collectSharedDataTextFromValue(target, seen, source, nestedValue, key);
  }
}

function collectTheorySharedDataFindings(): SharedDataTextFinding[] {
  const graph = buildNhm2TheoryBadgeGraphV1();
  const atlas = buildHelixPhysicsAtlasV1({ graph });
  const findings: SharedDataTextFinding[] = [];
  const seen = new Set<string>();

  graph.badges.forEach((badge) => collectSharedDataTextFromValue(findings, seen, `theory.badge.${badge.id}`, badge));
  graph.edges.forEach((edge) => collectSharedDataTextFromValue(findings, seen, `theory.edge.${edge.id}`, edge));
  atlas.blocks.forEach((block) => collectSharedDataTextFromValue(findings, seen, `theory.atlas.${block.id}`, block));
  [
    ["starsim", STARSIM_STELLAR_EVOLUTION_STAGES],
    ["cosmic_distance", COSMIC_DISTANCE_LADDER_RUNGS],
    ["solar_spectrum", SOLAR_SPECTRUM_OBSERVATION_GROUPS],
    ["casimir_cavity", CASIMIR_CAVITY_GROUPS],
    ["warp_gr_nhm2", WARP_GR_NHM2_GROUPS],
    ["qei_stress_energy", QEI_STRESS_ENERGY_GROUPS],
    ["tokamak_plasma", TOKAMAK_PLASMA_GROUPS],
    ["galactic_dynamics", GALACTIC_DYNAMICS_GROUPS],
    ["curvature_collapse", CURVATURE_COLLAPSE_GROUPS],
  ].forEach(([name, entries]) => collectSharedDataTextFromValue(findings, seen, `theory.preset.${name}`, entries));

  return findings;
}

function collectMoralSharedDataFindings(): SharedDataTextFinding[] {
  const findings: SharedDataTextFinding[] = [];
  const seen = new Set<string>();
  MORAL_LIVING_SUBSTRATE_PRINCIPLES.forEach((principle) =>
    collectSharedDataTextFromValue(findings, seen, `moral.living_substrate.${principle.id}`, principle),
  );
  MORAL_WISDOM_PRINCIPLES.forEach((principle) =>
    collectSharedDataTextFromValue(findings, seen, `moral.wisdom.${principle.id}`, principle),
  );
  return findings;
}

function uncatalogedSharedDataForPanel(panelId: string): SharedDataTextFinding[] {
  if (panelId === "theory-badge-graph") {
    const textMap = extractStaticTextMap(
      "client/src/components/panels/TheoryBadgeGraphPanel.tsx",
      "THEORY_GRAPH_STATIC_UI_TEXT_IDS",
    );
    return collectTheorySharedDataFindings().filter((finding) => !textMap.has(finding.text));
  }
  if (panelId === "moral-graph") {
    const textMap = extractStaticTextMap(
      "client/src/components/panels/MoralGraphPanel.tsx",
      "MORAL_GRAPH_STATIC_UI_TEXT_IDS",
    );
    return collectMoralSharedDataFindings().filter((finding) => !textMap.has(finding.text));
  }
  return [];
}

function collectHardcodedText(sourceFile: ts.SourceFile, repoRelativePath: string): HardcodedTextFinding[] {
  const findings: HardcodedTextFinding[] = [];

  const addFinding = (node: ts.Node, surface: string, rawText: string) => {
    const text = cleanText(rawText);
    if (!text || !/[A-Za-z]/.test(text)) return;
    const { line, column } = lineAndColumn(sourceFile, node.getStart(sourceFile));
    const classification = isDeveloperOrSymbolText(text, surface)
      ? "deferred_developer_or_symbol"
      : "unresolved_static_ui";
    findings.push({
      file: repoRelativePath,
      line,
      column,
      surface,
      text,
      classification,
    });
  };

  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      addFinding(node, "jsx-text", node.getText(sourceFile));
    } else if (ts.isJsxAttribute(node)) {
      const attrName = readAttributeName(node.name);
      if (ignoredAttributes.has(attrName)) return;
      if (node.initializer && ts.isStringLiteral(node.initializer)) {
        if (visibleStringAttributes.has(attrName)) {
          addFinding(node.initializer, attrName, node.initializer.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return findings;
}

function auditFile(repoRelativePath: string): {
  catalogRefs: string[];
  dynamicRefs: string[];
  findings: HardcodedTextFinding[];
  missing: boolean;
} {
  if (!fileExists(repoRelativePath)) {
    return {
      catalogRefs: [],
      dynamicRefs: [],
      findings: [{
        file: repoRelativePath,
        line: 1,
        column: 1,
        surface: "file",
        text: "Audit target file is missing",
        classification: "unresolved_static_ui",
      }],
      missing: true,
    };
  }
  const absolutePath = path.join(repoRoot, repoRelativePath);
  const text = fs.readFileSync(absolutePath, "utf8");
  const sourceFile = ts.createSourceFile(
    absolutePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    repoRelativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  return {
    catalogRefs: collectCatalogRefs(text),
    dynamicRefs: collectDynamicRefs(text),
    findings: collectHardcodedText(sourceFile, repoRelativePath),
    missing: false,
  };
}

function auditPanel(target: PanelAuditTarget): PanelCoverageReport {
  const catalogRefs = new Set<string>();
  const dynamicRefs = new Set<string>(target.dynamicContentRefs ?? []);
  const unresolvedStaticUi: HardcodedTextFinding[] = [];
  const deferredDeveloperOrSymbol: HardcodedTextFinding[] = [];

  for (const repoRelativePath of target.files) {
    const fileAudit = auditFile(repoRelativePath);
    fileAudit.catalogRefs.forEach((ref) => catalogRefs.add(ref));
    fileAudit.dynamicRefs.forEach((ref) => dynamicRefs.add(ref));
    for (const finding of fileAudit.findings) {
      if (finding.classification === "deferred_developer_or_symbol") {
        deferredDeveloperOrSymbol.push(finding);
      } else {
        unresolvedStaticUi.push(finding);
      }
    }
  }

  return {
    panelId: target.panelId,
    label: target.label,
    files: target.files.map(toRepoPath),
    catalogCoveredStaticRefs: Array.from(catalogRefs).sort(),
    dynamicTranslatableRefs: Array.from(dynamicRefs).sort(),
    unresolvedStaticUi,
    deferredDeveloperOrSymbol,
    uncatalogedSharedData: uncatalogedSharedDataForPanel(target.panelId),
  };
}

function uniqueSharedDataFindings(findings: SharedDataTextFinding[]): SharedDataTextFinding[] {
  const seen = new Set<string>();
  const unique: SharedDataTextFinding[] = [];
  for (const finding of findings) {
    const key = finding.text;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(finding);
  }
  return unique;
}

const panels = auditTargets.map(auditPanel);
const totals = panels.reduce(
  (acc, panel) => {
    acc.catalogCoveredStaticRefs += panel.catalogCoveredStaticRefs.length;
    acc.dynamicTranslatableRefs += panel.dynamicTranslatableRefs.length;
    acc.unresolvedStaticUi += panel.unresolvedStaticUi.length;
    acc.deferredDeveloperOrSymbol += panel.deferredDeveloperOrSymbol.length;
    acc.uncatalogedSharedData += panel.uncatalogedSharedData.length;
    return acc;
  },
  {
    catalogCoveredStaticRefs: 0,
    dynamicTranslatableRefs: 0,
    unresolvedStaticUi: 0,
    deferredDeveloperOrSymbol: 0,
    uncatalogedSharedData: 0,
  },
);
const uniqueUncatalogedSharedData = uniqueSharedDataFindings(
  panels.flatMap((panel) => panel.uncatalogedSharedData),
);
const hasBlockingLanguageGaps =
  totals.unresolvedStaticUi > 0 ||
  totals.uncatalogedSharedData > 0;

const summary = {
  ok: !hasBlockingLanguageGaps,
  purpose: "Report workstation language coverage by panel before adding more target languages.",
  classificationLegend: {
    catalogCoveredStaticRefs: "Stable UI routed through the interface catalog.",
    dynamicTranslatableRefs: "Runtime/domain content that should use translate-on-demand with provenance.",
    unresolvedStaticUi: "Likely stable UI still hardcoded in English and needing catalog coverage or explicit reclassification.",
    deferredDeveloperOrSymbol: "Developer-only, identifiers, symbols, or terse controls that can be reviewed later.",
    uncatalogedSharedData: "Stable shared graph data rendered by the UI but not yet backed by a static catalog id.",
  },
  totals,
  uniqueUncatalogedSharedDataCount: uniqueUncatalogedSharedData.length,
  uniqueUncatalogedSharedDataSample: uniqueUncatalogedSharedData.slice(0, 50),
  panels: panels.map((panel) => {
    const uniquePanelSharedData = uniqueSharedDataFindings(panel.uncatalogedSharedData);
    return {
      panelId: panel.panelId,
      label: panel.label,
      files: panel.files,
      catalogCoveredStaticRefCount: panel.catalogCoveredStaticRefs.length,
      catalogCoveredStaticRefs: panel.catalogCoveredStaticRefs,
      dynamicTranslatableRefCount: panel.dynamicTranslatableRefs.length,
      dynamicTranslatableRefs: panel.dynamicTranslatableRefs,
      unresolvedStaticUiCount: panel.unresolvedStaticUi.length,
      unresolvedStaticUiSample: panel.unresolvedStaticUi.slice(0, 25),
      deferredDeveloperOrSymbolCount: panel.deferredDeveloperOrSymbol.length,
      deferredDeveloperOrSymbolSample: panel.deferredDeveloperOrSymbol.slice(0, 15),
      uncatalogedSharedDataCount: panel.uncatalogedSharedData.length,
      uniqueUncatalogedSharedDataCount: uniquePanelSharedData.length,
      uncatalogedSharedDataSample: panel.uncatalogedSharedData.slice(0, 25),
      uniqueUncatalogedSharedDataSample: uniquePanelSharedData.slice(0, 25),
    };
  }),
};

console.log(JSON.stringify(summary, null, 2));
if (!summary.ok) {
  process.exit(1);
}
