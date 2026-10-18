import * as fs from "node:fs";
import * as path from "node:path";

type KnowledgeConcept = {
  id: string;
  aliases: string[];
  sourcePath: string;
};

type PanelConceptAudit = {
  panelIds: string[];
  keywordKeys: string[];
  keywordPhrases: string[];
  keywordTokens: string[];
};

type IdeologyAudit = {
  ids: string[];
  slugs: string[];
  titles: string[];
  titleTokens: string[];
};

type SuggestedConceptCard = {
  id: string;
  aliases: string[];
  anchors: string[];
  reason: string;
};

type ConceptAuditReport = {
  panelConcepts: {
    panelIdCount: number;
    keywordKeyCount: number;
    keywordPhraseCount: number;
    keywordTokenCount: number;
    panelIds: string[];
    keywordKeys: string[];
    keywordPhrases: string[];
  };
  ideologyNodes: {
    idCount: number;
    slugCount: number;
    titleCount: number;
    ids: string[];
    slugs: string[];
  };
  knowledgeConcepts: {
    conceptCount: number;
    ids: string[];
    aliases: string[];
  };
  missingConceptIds: {
    panelIds: string[];
    ideologyIds: string[];
    keywordTokens: string[];
  };
  missingAliases: string[];
  routingGaps: {
    missingLedgerAnchors: string[];
    missingStarAnchors: string[];
    missingIdeologyAnchors: string[];
  };
  suggestedConceptCards: SuggestedConceptCard[];
};

const ROOT = process.cwd();
const KNOWLEDGE_DIR = path.resolve(ROOT, "docs", "knowledge");
const PANELS_PATH = path.resolve(ROOT, "client", "src", "pages", "helix-core.panels.ts");
const IDEOLOGY_PATH = path.resolve(ROOT, "docs", "ethos", "ideology.json");
const REPORT_DIR = path.resolve(ROOT, "reports");
const REPORT_JSON = path.join(REPORT_DIR, "helix-ask-concept-audit.json");
const REPORT_MD = path.join(REPORT_DIR, "helix-ask-concept-audit.md");

const STOPWORDS = new Set(
  [
    "the",
    "and",
    "for",
    "with",
    "from",
    "into",
    "mode",
    "panel",
    "view",
    "system",
    "this",
    "that",
    "keep",
    "keeps",
    "used",
    "uses",
    "stay",
    "stays",
    "warp",
    "drive",
    "ledger",
    "helix",
    "ask",
    "pipeline",
    "core",
    "loop",
  ].map((s) => s.toLowerCase()),
);

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function unique<T>(items: Iterable<T>): T[] {
  return Array.from(new Set(items));
}

function parseAliases(raw: string | undefined): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1);
    return inner
      .split(",")
      .map((part) => part.trim().replace(/^"|"$/g, "").replace(/^'|'$/g, ""))
      .filter(Boolean);
  }
  if (trimmed.includes(",")) {
    return trimmed
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  }
  return [trimmed];
}

function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const lines = content.split(/\r?\n/);
  if (!lines.length || lines[0].trim() !== "---") {
    return { frontmatter: {}, body: content.trim() };
  }
  const frontmatter: Record<string, string> = {};
  let index = 1;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "---") {
      index += 1;
      break;
    }
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!match) continue;
    frontmatter[match[1]] = match[2].trim();
  }
  const body = lines.slice(index).join("\n").trim();
  return { frontmatter, body };
}

function loadKnowledgeConcepts(): KnowledgeConcept[] {
  if (!fs.existsSync(KNOWLEDGE_DIR)) return [];
  const concepts: KnowledgeConcept[] = [];
  const walk = (dir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
      const raw = fs.readFileSync(fullPath, "utf8");
      if (!raw.trim()) continue;
      const { frontmatter } = parseFrontmatter(raw);
      const id = (frontmatter.id ?? path.basename(entry.name, ".md")).trim();
      if (!id) continue;
      const aliases = parseAliases(frontmatter.aliases);
      concepts.push({
        id,
        aliases,
        sourcePath: path.relative(ROOT, fullPath).replace(/\\/g, "/"),
      });
    }
  };
  walk(KNOWLEDGE_DIR);
  return concepts;
}

function tokenizeTerms(terms: string[]): string[] {
  const tokens: string[] = [];
  for (const term of terms) {
    const pieces = term
      .split(/[^A-Za-z0-9_+-]+/)
      .map((piece) => piece.trim())
      .filter(Boolean);
    for (const piece of pieces) {
      const normalized = normalize(piece);
      if (normalized.length < 4) continue;
      if (STOPWORDS.has(normalized)) continue;
      tokens.push(normalized);
    }
  }
  return unique(tokens);
}

function extractPanelConcepts(): PanelConceptAudit {
  if (!fs.existsSync(PANELS_PATH)) {
    return { panelIds: [], keywordKeys: [], keywordPhrases: [], keywordTokens: [] };
  }
  const raw = fs.readFileSync(PANELS_PATH, "utf8");

  const panelIdMatches = raw.matchAll(/\bid:\s*"([^"]+)"/g);
  const panelIds = unique(Array.from(panelIdMatches, (match) => match[1]));

  const mapStart = raw.indexOf("const PANEL_KEYWORDS");
  const mapEnd = raw.indexOf("function lazyPanel");
  const mapSlice = mapStart >= 0 && mapEnd > mapStart ? raw.slice(mapStart, mapEnd) : raw;

  const keywordKeys = unique(Array.from(mapSlice.matchAll(/"([^"]+)"\s*:\s*\[/g), (m) => m[1]));
  const keywordStrings = Array.from(mapSlice.matchAll(/"([^"]+)"/g), (m) => m[1]);
  const keywordPhrases = unique(keywordStrings.filter((value) => !keywordKeys.includes(value)));
  const keywordTokens = tokenizeTerms(keywordPhrases);

  return { panelIds, keywordKeys, keywordPhrases, keywordTokens };
}

function extractIdeologyConcepts(): IdeologyAudit {
  if (!fs.existsSync(IDEOLOGY_PATH)) {
    return { ids: [], slugs: [], titles: [], titleTokens: [] };
  }
  const raw = fs.readFileSync(IDEOLOGY_PATH, "utf8");
  const parsed = JSON.parse(raw) as { nodes?: Array<Record<string, unknown>> };
  const nodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
  const ids: string[] = [];
  const slugs: string[] = [];
  const titles: string[] = [];
  for (const node of nodes) {
    const id = typeof node.id === "string" ? node.id : "";
    const slug = typeof node.slug === "string" ? node.slug : "";
    const title = typeof node.title === "string" ? node.title : "";
    if (id) ids.push(id);
    if (slug) slugs.push(slug);
    if (title) titles.push(title);
  }
  return {
    ids: unique(ids),
    slugs: unique(slugs),
    titles: unique(titles),
    titleTokens: tokenizeTerms(titles),
  };
}

function buildConceptIndex(concepts: KnowledgeConcept[]): Set<string> {
  const values: string[] = [];
  for (const concept of concepts) {
    values.push(normalize(concept.id));
    for (const alias of concept.aliases) {
      values.push(normalize(alias));
    }
  }
  return new Set(values.filter(Boolean));
}

function missingFromIndex(values: string[], index: Set<string>): string[] {
  const missing: string[] = [];
  for (const value of values) {
    const normalized = normalize(value);
    if (!normalized) continue;
    if (!index.has(normalized)) {
      missing.push(value);
    }
  }
  return unique(missing).sort();
}

const LEDGER_ANCHORS = [
  "sun-ledger",
  "stewardship-ledger",
  "warp-ledger",
  "curvature-ledger",
  "kappa-proxy",
  "potato-threshold",
  "qi-bounds",
  "stellar-ledger",
];

const STAR_ANCHORS = [
  "star-hydrostatic",
  "stellar-ledger",
  "solar-restoration",
  "potato-threshold",
  "red-giant-phase",
];

const IDEOLOGY_ANCHORS = [
  "mission-ethos",
  "ideology",
  "sun-ledger",
  "stewardship-ledger",
  "three-tenets-loop",
  "koan-governance",
  "interbeing-systems",
  "scarcity-justice",
];

const SUGGESTED_CARDS: SuggestedConceptCard[] = [
  {
    id: "sun-ledger",
    aliases: ["sun ledger", "stellar ledger", "tend the sun ledger"],
    anchors: ["docs/ethos/ideology.json", "docs/ethos/why.md"],
    reason: "Mission language appears in ideology docs and needs a concept anchor.",
  },
  {
    id: "stewardship-ledger",
    aliases: ["stewardship ledger", "ledger vow"],
    anchors: ["docs/ethos/ideology.json", "shared/curvature-proxy.ts"],
    reason: "Ideology guidance should map directly onto ledger math and guardrails.",
  },
  {
    id: "kappa-proxy",
    aliases: ["kappa_drive", "kappa_body", "curvature proxy"],
    anchors: ["shared/curvature-proxy.ts", "server/helix-proof-pack.ts"],
    reason: "kappa terms are central to ledger prompts and spread across math and proof-pack code.",
  },
  {
    id: "warp-ledger",
    aliases: ["warp ledger", "km-scale warp ledger", "curvature ledger"],
    anchors: ["shared/theory/curvature-collapse-theory-badges.ts", "shared/curvature-proxy.ts"],
    reason: "Current ledger explanations need the curvature proxy and diagnostic claim boundary; the standalone microsite is historical context.",
  },
  {
    id: "curvature-ledger",
    aliases: ["curvature ledger", "tensor ledger", "weyl bands"],
    anchors: ["shared/theory/curvature-collapse-theory-badges.ts", "shared/curvature-proxy.ts"],
    reason: "Curvature-ledger vocabulary needs the reduced-order proxy definitions and diagnostic claim boundaries, not the retired cycle-energy display.",
  },
  {
    id: "potato-threshold",
    aliases: ["potato threshold", "potato to sphere", "e_potato"],
    anchors: ["client/src/pages/star-hydrostatic-panel.tsx", "shared/theory/curvature-collapse-theory-badges.ts"],
    reason: "Shape-transition Pi and the drive/body curvature ratio need distinct teaching sources.",
  },
  {
    id: "qi-bounds",
    aliases: ["QI bounds", "quantum inequality bounds", "ford-roman bounds"],
    anchors: ["client/src/components/QiAutoTunerPanel.tsx", "server/energy-pipeline.ts"],
    reason: "QI guardrails show up in UI and pipeline math but are not routable concepts.",
  },
  {
    id: "star-hydrostatic",
    aliases: ["star hydrostatic", "stellar hydrostatic", "polytrope panel"],
    anchors: ["client/src/pages/star-hydrostatic-panel.tsx", "client/src/physics/polytrope.ts"],
    reason: "Star/solar prompts should ground to the hydrostatic panel and its solvers.",
  },
  {
    id: "stellar-ledger",
    aliases: ["stellar ledger", "star ledger"],
    anchors: ["client/src/pages/star-hydrostatic-panel.tsx", "docs/curvature-unit-solar-notes.md"],
    reason: "Stellar ledger wording appears in star panels but lacks a short concept card.",
  },
  {
    id: "solar-restoration",
    aliases: ["solar restoration", "save the sun", "restore the sun"],
    anchors: ["docs/ethos/why.md", "client/src/pages/star-watcher-panel.tsx"],
    reason: "Save-the-sun language should map to mission ethos and star telemetry panels.",
  },
  {
    id: "analysis-loops",
    aliases: ["analysis loop", "analysis loops", "belief graph loop"],
    anchors: ["server/routes/analysis-loops.ts", "modules/analysis/README.md"],
    reason: "Analysis loop routes and prototypes are referenced but not anchored as concepts.",
  },
  {
    id: "halobank",
    aliases: ["halobank", "halo ledger", "halobank timeline"],
    anchors: ["client/src/components/HalobankPanel.tsx", "halobank.html"],
    reason: "HaloBank UI vocabulary should have a concept card for routing and citations.",
  },
  {
    id: "casimir-tiles",
    aliases: ["casimir tiles", "casimir tile grid", "tile ledger"],
    anchors: ["docs/casimir-tile-mechanism.md", "client/src/components/panels/CasimirTilesPanel.tsx"],
    reason: "Casimir tile terminology spans docs and UI but needs a concept anchor.",
  },
  {
    id: "morphospace-attractors",
    aliases: ["morphospace attractor", "morphospace attractors", "morphospace"],
    anchors: [],
    reason: "Conceptual prompts require a general/hybrid fallback even without repo anchors.",
  },
  {
    id: "red-giant-phase",
    aliases: ["red giant phase", "red giant", "stellar evolution"],
    anchors: ["client/src/pages/start.tsx"],
    reason: "Star-evolution prompts should route to solar restoration context when present.",
  },
];

function ensureReportDir(): void {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
}

function writeMarkdown(report: ConceptAuditReport): void {
  const lines: string[] = [];
  lines.push("# Helix Ask Concept Audit");
  lines.push("");
  lines.push(`- Panel ids: ${report.panelConcepts.panelIdCount}`);
  lines.push(`- Panel keyword keys: ${report.panelConcepts.keywordKeyCount}`);
  lines.push(`- Panel keyword phrases: ${report.panelConcepts.keywordPhraseCount}`);
  lines.push(`- Knowledge concepts: ${report.knowledgeConcepts.conceptCount}`);
  lines.push(`- Ideology nodes: ${report.ideologyNodes.idCount}`);
  lines.push("");

  const missingPanel = report.missingConceptIds.panelIds.slice(0, 40);
  const missingIdeology = report.missingConceptIds.ideologyIds.slice(0, 40);
  const missingTokens = report.missingConceptIds.keywordTokens.slice(0, 60);

  lines.push("## Missing panel ids (first 40)");
  lines.push("");
  lines.push(missingPanel.length ? missingPanel.map((id) => `- ${id}`).join("\n") : "- none");
  lines.push("");

  lines.push("## Missing ideology ids (first 40)");
  lines.push("");
  lines.push(missingIdeology.length ? missingIdeology.map((id) => `- ${id}`).join("\n") : "- none");
  lines.push("");

  lines.push("## Missing keyword tokens (first 60)");
  lines.push("");
  lines.push(missingTokens.length ? missingTokens.map((id) => `- ${id}`).join("\n") : "- none");
  lines.push("");

  lines.push("## Missing alias phrases (first 60)");
  lines.push("");
  lines.push(
    report.missingAliases.length
      ? report.missingAliases.slice(0, 60).map((id) => `- ${id}`).join("\n")
      : "- none",
  );
  lines.push("");

  lines.push("## Routing gaps");
  lines.push("");
  lines.push(
    report.routingGaps.missingLedgerAnchors.length
      ? `- Missing ledger anchors: ${report.routingGaps.missingLedgerAnchors.join(", ")}`
      : "- Missing ledger anchors: none",
  );
  lines.push(
    report.routingGaps.missingStarAnchors.length
      ? `- Missing star anchors: ${report.routingGaps.missingStarAnchors.join(", ")}`
      : "- Missing star anchors: none",
  );
  lines.push(
    report.routingGaps.missingIdeologyAnchors.length
      ? `- Missing ideology anchors: ${report.routingGaps.missingIdeologyAnchors.join(", ")}`
      : "- Missing ideology anchors: none",
  );
  lines.push("");

  lines.push("## Suggested concept cards");
  lines.push("");
  for (const card of report.suggestedConceptCards) {
    lines.push(`- ${card.id}: ${card.reason}`);
    lines.push(`  - Anchors: ${card.anchors.join(", ")}`);
  }
  lines.push("");
  fs.writeFileSync(REPORT_MD, `${lines.join("\n").trim()}\n`, "utf8");
}

function main(): void {
  const knowledgeConcepts = loadKnowledgeConcepts();
  const conceptIndex = buildConceptIndex(knowledgeConcepts);
  const panelAudit = extractPanelConcepts();
  const ideologyAudit = extractIdeologyConcepts();

  const panelMissingIds = missingFromIndex(panelAudit.panelIds, conceptIndex);
  const ideologyMissingIds = missingFromIndex(ideologyAudit.ids, conceptIndex);
  const keywordTokenMissing = missingFromIndex(panelAudit.keywordTokens, conceptIndex);

  const allAliases = unique(knowledgeConcepts.flatMap((concept) => concept.aliases));
  const aliasCandidates = unique([
    ...panelAudit.keywordPhrases,
    ...ideologyAudit.titles,
    ...ideologyAudit.slugs,
  ]);
  const missingAliases = missingFromIndex(aliasCandidates, conceptIndex);

  const missingLedgerAnchors = missingFromIndex(LEDGER_ANCHORS, conceptIndex);
  const missingStarAnchors = missingFromIndex(STAR_ANCHORS, conceptIndex);
  const missingIdeologyAnchors = missingFromIndex(IDEOLOGY_ANCHORS, conceptIndex);

  const report: ConceptAuditReport = {
    panelConcepts: {
      panelIdCount: panelAudit.panelIds.length,
      keywordKeyCount: panelAudit.keywordKeys.length,
      keywordPhraseCount: panelAudit.keywordPhrases.length,
      keywordTokenCount: panelAudit.keywordTokens.length,
      panelIds: panelAudit.panelIds,
      keywordKeys: panelAudit.keywordKeys,
      keywordPhrases: panelAudit.keywordPhrases,
    },
    ideologyNodes: {
      idCount: ideologyAudit.ids.length,
      slugCount: ideologyAudit.slugs.length,
      titleCount: ideologyAudit.titles.length,
      ids: ideologyAudit.ids,
      slugs: ideologyAudit.slugs,
    },
    knowledgeConcepts: {
      conceptCount: knowledgeConcepts.length,
      ids: knowledgeConcepts.map((concept) => concept.id).sort(),
      aliases: allAliases.sort(),
    },
    missingConceptIds: {
      panelIds: panelMissingIds,
      ideologyIds: ideologyMissingIds,
      keywordTokens: keywordTokenMissing,
    },
    missingAliases,
    routingGaps: {
      missingLedgerAnchors,
      missingStarAnchors,
      missingIdeologyAnchors,
    },
    suggestedConceptCards: SUGGESTED_CARDS.filter(
      (card) => !conceptIndex.has(normalize(card.id)),
    ),
  };

  ensureReportDir();
  fs.writeFileSync(REPORT_JSON, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeMarkdown(report);

  console.log(`[helix-ask-concept-audit] wrote ${path.relative(ROOT, REPORT_JSON)}`);
  console.log(`[helix-ask-concept-audit] wrote ${path.relative(ROOT, REPORT_MD)}`);
  console.log(
    `[helix-ask-concept-audit] missing panel ids=${panelMissingIds.length} ideology ids=${ideologyMissingIds.length} keyword tokens=${keywordTokenMissing.length}`,
  );
}

main();

