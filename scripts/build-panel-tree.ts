import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";

type PanelTermHit = {
  term: string;
  files: string[];
  treeMatches: Array<{ treeId: string; nodeId: string; title?: string; tags?: string[] }>;
};

type PanelRecord = {
  id: string;
  title?: string;
  keywords?: string[];
  endpoints?: string[];
  componentPath?: string | null;
  terms?: string[];
  termHits?: PanelTermHit[];
};

type PanelReport = {
  generatedAt: string;
  repoRev: string;
  panels: PanelRecord[];
};

const REPORT_PATH = path.join("reports", "panel-cross-concepts.json");
const OUTPUT_PATH = path.join("docs", "knowledge", "panel-registry-tree.json");
const CONCEPT_OUTPUT_PATH = path.join("docs", "knowledge", "panel-concepts-tree.json");
const PHYSICS_TREE_HINTS = [
  /physics/i,
  /warp/i,
  /casimir/i,
  /gr-/i,
  /stellar/i,
  /star-/i,
  /resonance/i,
  /simulation/i,
  /math-tree/i,
  /uncertainty/i
];
const IDEOLOGY_TREE_HINTS = [/mission-ethos/i];

const sha256 = (filePath: string): string | null => {
  try {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
};

const safePath = (filePath: string | null | undefined): string | null => {
  if (!filePath) return null;
  return filePath.replace(/\\/g, "/");
};

const classifyEvidence = (filePath: string): "doc" | "test" | "telemetry" | "code" => {
  if (filePath.startsWith("docs/")) return "doc";
  if (/__tests__|\.spec\.|\.test\./i.test(filePath)) return "test";
  if (/telemetry|metrics|kpi/i.test(filePath)) return "telemetry";
  return "code";
};

const uniqueLimit = (items: string[], limit: number) => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
};

const run = () => {
  if (!fs.existsSync(REPORT_PATH)) {
    throw new Error(`Missing ${REPORT_PATH}. Run scripts/panel-cross-concepts.ts first.`);
  }
  const report = JSON.parse(fs.readFileSync(REPORT_PATH, "utf8")) as PanelReport;
  const repoRev = report.repoRev || execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  const registryHash = sha256("client/src/pages/helix-core.panels.ts");
  const panelNodes: any[] = [];
  const bridgeNodes: any[] = [];
  const conceptNodes: any[] = [];
  const conceptBridgeNodes: any[] = [];

  for (const panel of report.panels) {
    const nodeId = `panel-${panel.id}`;
    const title = panel.title || panel.id;
    const keywords = (panel.keywords ?? []).filter(Boolean);
    const tags = Array.from(new Set(["panel", panel.id, ...keywords])).slice(0, 24);
    const links: Array<{ rel: string; to: string }> = [
      { rel: "parent", to: "panel-registry-tree" }
    ];

    const matchedNodes = new Set<string>();
    const matchEvidence = new Map<string, { term: string; file?: string }>();
    (panel.termHits ?? []).forEach((hit) => {
      hit.treeMatches?.forEach((match) => {
        if (match.treeId === "panel-registry-tree") return;
        if (match.nodeId === nodeId) return;
        const key = `${match.treeId}:${match.nodeId}`;
        matchedNodes.add(key);
        if (!matchEvidence.has(key)) {
          matchEvidence.set(key, { term: hit.term, file: hit.files?.[0] });
        }
      });
    });
    const matchedList: string[] = [];
    const matchedNodeIds = new Set<string>();
    for (const key of matchedNodes) {
      const [, nodeIdMatch] = key.split(":");
      if (!nodeIdMatch) continue;
      if (matchedNodeIds.has(nodeIdMatch)) continue;
      matchedNodeIds.add(nodeIdMatch);
      matchedList.push(key);
      if (matchedList.length >= 6) break;
    }
    for (const key of matchedList) {
      const [, nodeIdMatch] = key.split(":");
      if (nodeIdMatch) {
        links.push({ rel: "see-also", to: nodeIdMatch });
      }
    }

    const componentPath = safePath(panel.componentPath);
    const evidence: any[] = [];
    if (componentPath && fs.existsSync(componentPath)) {
      const hash = sha256(componentPath);
      evidence.push({
        type: "code",
        path: componentPath,
        repo_rev: repoRev,
        content_hash: hash ? `sha256:${hash}` : undefined
      });
    }
    const termFiles = (panel.termHits ?? []).flatMap((hit) => hit.files ?? []);
    const limitedTermFiles = uniqueLimit(termFiles, 12).map((file) => safePath(file)).filter(Boolean) as string[];
    const categorized = new Map<string, string[]>();
    for (const file of limitedTermFiles) {
      const kind = classifyEvidence(file);
      const list = categorized.get(kind) ?? [];
      list.push(file);
      categorized.set(kind, list);
    }
    for (const [kind, files] of categorized.entries()) {
      const picks = uniqueLimit(files, kind === "doc" ? 2 : kind === "test" ? 1 : 2);
      for (const file of picks) {
        if (!fs.existsSync(file)) continue;
        const hash = sha256(file);
        evidence.push({
          type: kind,
          path: file,
          repo_rev: repoRev,
          content_hash: hash ? `sha256:${hash}` : undefined
        });
      }
    }
    evidence.push({
      type: "doc",
      path: "client/src/pages/helix-core.panels.ts",
      repo_rev: repoRev,
      content_hash: registryHash ? `sha256:${registryHash}` : undefined
    });

    const panelChildren: string[] = [];
    for (const key of matchedList) {
      const [, nodeIdMatch] = key.split(":");
      if (!nodeIdMatch) continue;
      const bridgeId = `bridge-${nodeId}-${nodeIdMatch}`;
      panelChildren.push(bridgeId);
      const evidenceHit = matchEvidence.get(key);
      const evidenceEntries: any[] = [];
      if (evidenceHit?.file) {
        const hitPath = safePath(evidenceHit.file);
        if (hitPath && fs.existsSync(hitPath)) {
          const hash = sha256(hitPath);
          const type =
            hitPath.startsWith("docs/")
              ? "doc"
              : hitPath.startsWith("client/") ||
                hitPath.startsWith("server/") ||
                hitPath.startsWith("modules/") ||
                hitPath.startsWith("shared/")
              ? "code"
              : "doc";
          evidenceEntries.push({
            type,
            path: hitPath,
            repo_rev: repoRev,
            content_hash: hash ? `sha256:${hash}` : undefined
          });
        }
      }
      evidenceEntries.push({
        type: "doc",
        path: "client/src/pages/helix-core.panels.ts",
        repo_rev: repoRev,
        content_hash: registryHash ? `sha256:${registryHash}` : undefined
      });
      bridgeNodes.push({
        id: bridgeId,
        slug: bridgeId,
        title: `${title} <-> ${nodeIdMatch}`,
        excerpt: `Bridge between panel ${panel.id} and ${nodeIdMatch}.`,
        bodyMD: `Panel ${panel.id} links to ${nodeIdMatch} via term "${evidenceHit?.term ?? "match"}".`,
        tags: ["bridge", "panel", panel.id],
        nodeType: "bridge",
        links: [
          { rel: "parent", to: nodeId },
          { rel: "see-also", to: nodeIdMatch },
          { rel: "see-also", to: nodeId }
        ],
        bridge: {
          left: nodeId,
          right: nodeIdMatch,
          relation: "Panel cross-concept join"
        },
        inputs: [],
        outputs: [],
        assumptions: [],
        validity: {},
        deterministic: null,
        tolerance: null,
        environment: null,
        dependencies: [nodeId, nodeIdMatch],
        evidence: evidenceEntries.filter((entry) => entry.content_hash || entry.type !== "code"),
        predictability: {
          status: "partial",
          missing: [
            "inputs",
            "outputs",
            "assumptions",
            "validity",
            "deterministic",
            "tolerance",
            "environment"
          ]
        }
      });
    }

    const endpoints = (panel.endpoints ?? []).filter(Boolean);
    const bodyLines = [
      `Panel ${panel.id} loaded from helix-core panels registry.`,
      componentPath ? `Component: ${componentPath}` : "Component: (unresolved)",
      endpoints.length ? `Endpoints: ${endpoints.join(", ")}` : "Endpoints: none",
      keywords.length ? `Keywords: ${keywords.join(", ")}` : "Keywords: none"
    ];

    panelNodes.push({
      id: nodeId,
      slug: nodeId,
      title,
      excerpt: `Panel surface for ${title}.`,
      bodyMD: bodyLines.join("\n"),
      tags,
      children: panelChildren,
      links,
      summary: `Panel surface for ${title}.`,
      nodeType: "concept",
      inputs: [],
      outputs: [],
      assumptions: [],
      validity: {},
      deterministic: null,
      tolerance: null,
      environment: null,
      dependencies: ["panel-registry-tree"],
      evidence: evidence.filter((entry) => entry.content_hash || entry.type !== "code"),
      predictability: {
        status: "partial",
        missing: [
          "inputs",
          "outputs",
          "assumptions",
          "validity",
          "deterministic",
          "tolerance",
          "environment"
        ]
      }
    });

    const conceptChildren: string[] = [];
    const conceptLinks: Array<{ rel: string; to: string }> = [
      { rel: "parent", to: "panel-concepts-tree" }
    ];
    const conceptSeeAlso = new Set<string>();
    (panel.termHits ?? []).forEach((hit) => {
      hit.treeMatches?.forEach((match) => {
        if (match.treeId === "panel-registry-tree" || match.treeId === "panel-concepts-tree") return;
        if (!match.nodeId) return;
        conceptSeeAlso.add(match.nodeId);
      });
    });
    for (const nodeIdMatch of Array.from(conceptSeeAlso).slice(0, 6)) {
      conceptLinks.push({ rel: "see-also", to: nodeIdMatch });
    }

    const conceptBridgeTargets = new Map<string, { term?: string; file?: string }>();
    (panel.termHits ?? []).forEach((hit) => {
      hit.treeMatches?.forEach((match) => {
        if (!match.nodeId || !match.treeId) return;
        if (!PHYSICS_TREE_HINTS.some((re) => re.test(match.treeId))) return;
        const key = match.nodeId;
        if (!conceptBridgeTargets.has(key)) {
          conceptBridgeTargets.set(key, { term: hit.term, file: hit.files?.[0] });
        }
      });
    });
    for (const [nodeIdMatch, evidenceHit] of Array.from(conceptBridgeTargets.entries()).slice(0, 6)) {
      const bridgeId = `bridge-panel-concept-${panel.id}-${nodeIdMatch}`;
      conceptChildren.push(bridgeId);
      const evidenceEntries: any[] = [];
      if (evidenceHit?.file) {
        const hitPath = safePath(evidenceHit.file);
        if (hitPath && fs.existsSync(hitPath)) {
          const hash = sha256(hitPath);
          const type = hitPath.startsWith("docs/")
            ? "doc"
            : hitPath.startsWith("client/") ||
              hitPath.startsWith("server/") ||
              hitPath.startsWith("modules/") ||
              hitPath.startsWith("shared/")
            ? "code"
            : "doc";
          evidenceEntries.push({
            type,
            path: hitPath,
            repo_rev: repoRev,
            content_hash: hash ? `sha256:${hash}` : undefined
          });
        }
      }
      evidenceEntries.push({
        type: "doc",
        path: "client/src/pages/helix-core.panels.ts",
        repo_rev: repoRev,
        content_hash: registryHash ? `sha256:${registryHash}` : undefined
      });
      conceptBridgeNodes.push({
        id: bridgeId,
        slug: bridgeId,
        title: `${title} Concept <-> ${nodeIdMatch}`,
        excerpt: `Bridge between panel concept ${panel.id} and ${nodeIdMatch}.`,
        bodyMD: `Panel concept ${panel.id} links to ${nodeIdMatch} via term "${evidenceHit?.term ?? "match"}".`,
        tags: ["bridge", "panel-concept", panel.id],
        nodeType: "bridge",
        links: [
          { rel: "parent", to: `panel-concept-${panel.id}` },
          { rel: "see-also", to: nodeIdMatch },
          { rel: "see-also", to: `panel-concept-${panel.id}` }
        ],
        bridge: {
          left: `panel-concept-${panel.id}`,
          right: nodeIdMatch,
          relation: "Panel concept physics join"
        },
        inputs: [],
        outputs: [],
        assumptions: [],
        validity: {},
        deterministic: null,
        tolerance: null,
        environment: null,
        dependencies: [`panel-concept-${panel.id}`, nodeIdMatch],
        evidence: evidenceEntries.filter((entry) => entry.content_hash || entry.type !== "code"),
        predictability: {
          status: "partial",
          missing: [
            "inputs",
            "outputs",
            "assumptions",
            "validity",
            "deterministic",
            "tolerance",
            "environment"
          ]
        }
      });
    }

    const ideologyBridgeTargets = new Map<string, { term?: string; file?: string }>();
    (panel.termHits ?? []).forEach((hit) => {
      hit.treeMatches?.forEach((match) => {
        if (!match.nodeId || !match.treeId) return;
        if (!IDEOLOGY_TREE_HINTS.some((re) => re.test(match.treeId))) return;
        const key = match.nodeId;
        if (!ideologyBridgeTargets.has(key)) {
          ideologyBridgeTargets.set(key, { term: hit.term, file: hit.files?.[0] });
        }
      });
    });
    for (const [nodeIdMatch, evidenceHit] of Array.from(ideologyBridgeTargets.entries()).slice(0, 6)) {
      const bridgeId = `bridge-panel-concept-ethos-${panel.id}-${nodeIdMatch}`;
      conceptChildren.push(bridgeId);
      const evidenceEntries: any[] = [];
      if (evidenceHit?.file) {
        const hitPath = safePath(evidenceHit.file);
        if (hitPath && fs.existsSync(hitPath)) {
          const hash = sha256(hitPath);
          const type = hitPath.startsWith("docs/")
            ? "doc"
            : hitPath.startsWith("client/") ||
              hitPath.startsWith("server/") ||
              hitPath.startsWith("modules/") ||
              hitPath.startsWith("shared/")
            ? "code"
            : "doc";
          evidenceEntries.push({
            type,
            path: hitPath,
            repo_rev: repoRev,
            content_hash: hash ? `sha256:${hash}` : undefined
          });
        }
      }
      evidenceEntries.push({
        type: "doc",
        path: "client/src/pages/helix-core.panels.ts",
        repo_rev: repoRev,
        content_hash: registryHash ? `sha256:${registryHash}` : undefined
      });
      conceptBridgeNodes.push({
        id: bridgeId,
        slug: bridgeId,
        title: `${title} Ethos Concept <-> ${nodeIdMatch}`,
        excerpt: `Bridge between panel concept ${panel.id} and ${nodeIdMatch}.`,
        bodyMD: `Panel concept ${panel.id} links to ${nodeIdMatch} via term "${evidenceHit?.term ?? "match"}".`,
        tags: ["bridge", "panel-concept", "ethos", panel.id],
        nodeType: "bridge",
        links: [
          { rel: "parent", to: `panel-concept-${panel.id}` },
          { rel: "see-also", to: nodeIdMatch },
          { rel: "see-also", to: `panel-concept-${panel.id}` }
        ],
        bridge: {
          left: `panel-concept-${panel.id}`,
          right: nodeIdMatch,
          relation: "Panel concept mission ethos join"
        },
        inputs: [],
        outputs: [],
        assumptions: [],
        validity: {},
        deterministic: null,
        tolerance: null,
        environment: null,
        dependencies: [`panel-concept-${panel.id}`, nodeIdMatch],
        evidence: evidenceEntries.filter((entry) => entry.content_hash || entry.type !== "code"),
        predictability: {
          status: "partial",
          missing: [
            "inputs",
            "outputs",
            "assumptions",
            "validity",
            "deterministic",
            "tolerance",
            "environment"
          ]
        }
      });
    }

    const conceptTags = Array.from(
      new Set([
        "panel-concept",
        panel.id,
        ...(panel.keywords ?? []),
        ...(panel.terms ?? []),
        ...(panel.units ?? []),
        ...(panel.telemetryTokens ?? [])
      ]),
    ).slice(0, 32);

    conceptNodes.push({
      id: `panel-concept-${panel.id}`,
      slug: `panel-concept-${panel.id}`,
      title: `${title} Concept`,
      excerpt: `Concept surface derived from panel ${panel.id}.`,
      bodyMD: bodyLines.join("\n"),
      tags: conceptTags,
      children: conceptChildren,
      links: conceptLinks,
      summary: `Concept surface derived from panel ${panel.id}.`,
      nodeType: "concept",
      inputs: [],
      outputs: [],
      assumptions: [],
      validity: {},
      deterministic: null,
      tolerance: null,
      environment: null,
      dependencies: ["panel-concepts-tree"],
      evidence: evidence.filter((entry) => entry.content_hash || entry.type !== "code"),
      predictability: {
        status: "partial",
        missing: [
          "inputs",
          "outputs",
          "assumptions",
          "validity",
          "deterministic",
          "tolerance",
          "environment"
        ]
      }
    });
  }

  const rootNode = {
    id: "panel-registry-tree",
    slug: "panel-registry-tree",
    title: "Panel Registry Tree",
    excerpt: "Panel surfaces and cross-concept joins derived from Helix UI.",
    bodyMD:
      "This tree enumerates Helix panels and their cross-concept joins to keep UI surfaces grounded in the DAG.\n\nMinimal artifact: panel registry map.",
    tags: ["ui", "panels", "registry"],
    children: panelNodes.map((node) => node.id),
    links: [],
    summary: "Panel surfaces and cross-concept joins derived from Helix UI.",
    nodeType: "concept",
    inputs: [],
    outputs: [],
    assumptions: [],
    validity: {},
    deterministic: null,
    tolerance: null,
    environment: null,
    dependencies: [],
    evidence: [
      {
        type: "doc",
        path: "client/src/pages/helix-core.panels.ts",
        repo_rev: repoRev,
        content_hash: registryHash ? `sha256:${registryHash}` : undefined
      }
    ],
    predictability: {
      status: "partial",
      missing: [
        "inputs",
        "outputs",
        "assumptions",
        "validity",
        "deterministic",
        "tolerance",
        "environment"
      ]
    }
  };

  const payload = {
    version: 1,
    rootId: "panel-registry-tree",
    nodes: [rootNode, ...panelNodes, ...bridgeNodes],
    schema: {
      name: "helix-ask-dag-node",
      version: 1
    }
  };

  const conceptRoot = {
    id: "panel-concepts-tree",
    slug: "panel-concepts-tree",
    title: "Panel Concepts Tree",
    excerpt: "Panel-derived concepts for cross-concept discovery.",
    bodyMD:
      "This tree enumerates concepts inferred from UI panels (keywords, telemetry tokens, units) so Helix Ask can cross-map panel surfaces to DAG concepts.\n\nMinimal artifact: panel registry term map.",
    tags: ["ui", "panels", "concepts"],
    children: conceptNodes.map((node) => node.id),
    links: [],
    summary: "Panel-derived concepts for cross-concept discovery.",
    nodeType: "concept",
    inputs: [],
    outputs: [],
    assumptions: [],
    validity: {},
    deterministic: null,
    tolerance: null,
    environment: null,
    dependencies: [],
    evidence: [
      {
        type: "doc",
        path: "client/src/pages/helix-core.panels.ts",
        repo_rev: repoRev,
        content_hash: registryHash ? `sha256:${registryHash}` : undefined
      }
    ],
    predictability: {
      status: "partial",
      missing: [
        "inputs",
        "outputs",
        "assumptions",
        "validity",
        "deterministic",
        "tolerance",
        "environment"
      ]
    }
  };
  const conceptPayload = {
    version: 1,
    rootId: "panel-concepts-tree",
    nodes: [conceptRoot, ...conceptNodes, ...conceptBridgeNodes],
    schema: {
      name: "helix-ask-dag-node",
      version: 1
    }
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2));
  fs.writeFileSync(CONCEPT_OUTPUT_PATH, JSON.stringify(conceptPayload, null, 2));
  console.log(`Wrote ${OUTPUT_PATH} (${payload.nodes.length} nodes).`);
  console.log(`Wrote ${CONCEPT_OUTPUT_PATH} (${conceptPayload.nodes.length} nodes).`);
};

run();
