import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";
import { createCanvas } from "@napi-rs/canvas";
import {
  buildShiftPlusLapseComparisonPayload,
  writeShiftPlusLapseComparisonArtifacts,
} from "./warp-shift-plus-lapse-comparison.js";
import { renderRenderTaxonomyAuditMarkdown } from "./warp-york-control-family-proof-pack.js";

const DATE_STAMP = "2026-04-01";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_JSON = path.join(
  ROOT,
  "artifacts",
  "research",
  "full-solve",
  "nhm2-shift-plus-lapse-dashboard-latest.json",
);
const OUT_AUDIT = path.join(
  ROOT,
  "docs",
  "audits",
  "research",
  "warp-nhm2-shift-plus-lapse-dashboard-latest.md",
);
const OUT_MEMO = path.join(
  ROOT,
  "docs",
  "research",
  "nhm2-shift-plus-lapse-dashboard-memo-2026-04-01.md",
);
const OUT_RENDER_DIR = path.join(
  ROOT,
  "artifacts",
  "research",
  "full-solve",
  "rendered",
  "comparison_panel",
  DATE_STAMP,
);
const LEGACY_CARD_PATH = path.join(
  OUT_RENDER_DIR,
  "nhm2_shift_lapse-comparison_panel-diagnostics_dashboard-card.png",
);
const OUT_RENDER_TAXONOMY_JSON = path.join(
  ROOT,
  "artifacts",
  "research",
  "full-solve",
  "render-taxonomy-latest.json",
);
const OUT_RENDER_TAXONOMY_AUDIT = path.join(
  ROOT,
  "docs",
  "audits",
  "research",
  "warp-render-taxonomy-latest.md",
);
const PROOF_PACK_LATEST_JSON = path.join(
  ROOT,
  "artifacts",
  "research",
  "full-solve",
  "warp-york-control-family-proof-pack-latest.json",
);
const PROOF_PACK_LATEST_AUDIT = path.join(
  ROOT,
  "docs",
  "audits",
  "research",
  "warp-york-control-family-proof-pack-latest.md",
);
const SOURCE_FORMULA_AUDIT_LATEST_JSON = path.join(
  ROOT,
  "artifacts",
  "research",
  "full-solve",
  "nhm2-source-formula-audit-latest.json",
);
const SOURCE_MECHANISM_MATURITY_LATEST_JSON = path.join(
  ROOT,
  "artifacts",
  "research",
  "full-solve",
  "nhm2-source-mechanism-maturity-latest.json",
);
const SOURCE_MECHANISM_PROMOTION_CONTRACT_LATEST_JSON = path.join(
  ROOT,
  "artifacts",
  "research",
  "full-solve",
  "nhm2-source-mechanism-promotion-contract-latest.json",
);
const SOURCE_MECHANISM_PARITY_ROUTE_LATEST_JSON = path.join(
  ROOT,
  "artifacts",
  "research",
  "full-solve",
  "nhm2-source-mechanism-parity-route-feasibility-latest.json",
);
const OUT_SOURCE_MECHANISM_CONFORMANCE_JSON = path.join(
  ROOT,
  "artifacts",
  "research",
  "full-solve",
  "nhm2-source-mechanism-consumer-conformance-latest.json",
);
const OUT_SOURCE_MECHANISM_CONFORMANCE_AUDIT = path.join(
  ROOT,
  "docs",
  "audits",
  "research",
  "warp-nhm2-source-mechanism-consumer-conformance-latest.md",
);

const DASHBOARD_LAYOUT_VERSION = "v2_measured_card_family";
const SPEED_OF_LIGHT_MPS = 299_792_458;
const SECONDS_PER_DAY = 86_400;
const GRAPH_SAMPLE_COUNT = 9;
const FONT_FAMILY = "'Segoe UI', Arial, sans-serif";
const CARD_MARGIN = 24;
const HEADER_HEIGHT = 106;
const HEADER_BADGE_WIDTH = 420;
const SECTION_GAP = 18;
const ROW_PADDING = 22;
const BADGE_HEIGHT = 28;
const BADGE_GAP = 8;

const LAYOUT_BUDGET = {
  maxContentWidth: 1460,
  columnWidthBudget: 420,
  rowPadding: 18,
  sectionPadding: 22,
  badgeWrapThreshold: 220,
  noteWrapWidth: 1280,
  minCardHeight: 520,
  dynamicCardHeight: true,
  measuredTextRenderer: "@napi-rs/canvas.measureText",
} as const;

type DashboardPanelId =
  | "proof_status_panel"
  | "cabin_gravity_panel"
  | "wall_safety_panel"
  | "precision_panel";

type DashboardCardId =
  | "dashboard_overview"
  | "proof_status"
  | "cabin_gravity"
  | "wall_safety"
  | "precision_provenance";

type DashboardGraphId =
  | "cabin_gravity_profile_z"
  | "clock_gradient_profile_z";

type DashboardRow = {
  rowId: string;
  label: string;
  baselineValue: unknown;
  generalizedValue: unknown;
  units: string;
  delta: unknown;
  baselineSourceKind?: string | null;
  generalizedSourceKind?: string | null;
  badgeId: string;
  badgeIds: string[];
  crossCaseSourceMismatch: boolean;
  note: string;
};

type DashboardPanel = {
  panelId: DashboardPanelId;
  title: string;
  purpose: string;
  rows: DashboardRow[];
  sectionNote: string;
};

type BadgeDefinition = {
  badgeId: string;
  label: string;
  meaning: string;
  displayPriority: number;
};

type DashboardCardEntry = {
  cardId: DashboardCardId;
  title: string;
  path: string;
  hash: string;
  renderCategory: "comparison_panel";
  renderRole: "presentation";
  sectionSource: string;
  layoutVersion: string;
  primary: boolean;
};

type DashboardGraphSeriesBlock = {
  graphId: DashboardGraphId;
  title: string;
  quantitySymbol: string;
  quantityUnits: string;
  sampleAxis: string;
  sampleAxisLabel: string;
  sampleDomain: number[];
  sampleCount: number;
  baselineSeries: Array<number | null>;
  generalizedSeries: Array<number | null>;
  baselineSourceKind: string;
  generalizedSourceKind: string;
  baselineSeriesStatus: string;
  generalizedSeriesStatus: string;
  baselineBadgeIds: string[];
  generalizedBadgeIds: string[];
  sharedBadgeIds: string[];
  underResolutionDetected: boolean;
  graphNote: string;
};

type DashboardGraphRenderEntry = {
  graphId: DashboardGraphId;
  title: string;
  path: string;
  hash: string;
  renderCategory: "comparison_panel";
  renderRole: "presentation";
  authoritativeStatus: "non_authoritative";
  sourcePanel: DashboardPanelId;
  sourceSeriesBlock: DashboardGraphId;
  layoutVersion: string;
};

type SourceMechanismPolicyContext = {
  contractStatus: string;
  selectedPromotionRoute: string;
  exemptionRouteActivated: boolean;
  nonAuthoritative: boolean;
  formulaEquivalent: boolean;
  parityRouteStatus: string;
  parityRouteBlockingClass: string;
  activeClaimSet: string[];
  blockedClaimSet: string[];
  forbiddenPromotions: string[];
  requiredDisclaimers: string[];
  referenceOnlyScope: boolean;
  consumerSummary: string;
};

type SourceMechanismConsumerSurfaceCheck = {
  surfaceId: string;
  surfaceType: string;
  inspectionMode: "direct_content" | "pre_raster_render_source";
  dataMode: "artifact_coupled" | "current_build_graph";
  status: "conformant" | "non_conformant";
  checkedTargets: string[];
  checkedFields: string[];
  verifiedFields: string[];
  missingDisclaimers: string[];
  leakedInferences: string[];
  laneAAuthorityChecks: string[];
  laneAAuthorityPresent: boolean;
  referenceOnlyChecks: string[];
  referenceOnlyPresent: boolean;
  notes: string[];
};

type SourceMechanismConsumerConformanceSummary = {
  consumerConformanceStatus: "conformant" | "non_conformant";
  conformanceDataMode:
    | "current_build_graph"
    | "artifact_coupled"
    | "mixed_current_build_and_artifact_coupled";
  stalenessRisk: "none" | "possible_latest_artifact_drift";
  artifactCouplingNote: string;
  checkedSurfaces: SourceMechanismConsumerSurfaceCheck[];
  conformantSurfaces: string[];
  nonConformantSurfaces: string[];
  activeClaimSet: string[];
  blockedClaimSet: string[];
  requiredDisclaimers: string[];
  forbiddenInferences: string[];
  referenceOnlyScopePreserved: boolean;
  referenceOnlyMissingOnSurfaces: string[];
  laneAAuthorityPreserved: boolean;
  laneAAuthorityMissingOnSurfaces: string[];
  summary: string;
  artifactPath: string;
  reportPath: string;
};

type SourceMechanismConsumerConformanceArtifact = {
  artifactType: "nhm2_source_mechanism_consumer_conformance/v1";
  generatedOn: string;
  generatedAt: string;
  boundaryStatement: string;
  proofPackArtifact: string;
  proofPackReport: string;
  promotionContractArtifact: string;
  maturityArtifact: string;
  dashboardArtifact: string;
  dashboardReport: string;
  renderedCardDirectory: string;
  sourceMechanismConsumerConformance: Omit<
    SourceMechanismConsumerConformanceSummary,
    "artifactPath" | "reportPath"
  >;
  notes: string[];
  checksum?: string;
};

type DashboardPayload = {
  artifactId: string;
  capturedAt: string;
  date: string;
  dashboardId: string;
  dashboardStatus: string;
  comparisonId: string;
  scenarioId: string;
  dashboardSurfaceKind: string;
  dashboardLayoutVersion: string;
  layoutBudget: typeof LAYOUT_BUDGET;
  renderedCardFamilyStatus: string;
  renderedCardReadingOrder: DashboardCardId[];
  primaryRenderedCardId: DashboardCardId | null;
  renderedCards: DashboardCardEntry[];
  legacyMonolithicCardStatus: string;
  legacyMonolithicCardPath: string | null;
  renderedCardStatus: string;
  renderedCardPath: string | null;
  renderedCardHash: string | null;
  renderedCardCategory: string | null;
  renderedCardRole: string | null;
  renderedCardLayoutVersion: string | null;
  graphRenderStatus: string;
  graphReadingOrder: DashboardGraphId[];
  graphSeriesBlocks: DashboardGraphSeriesBlock[];
  graphRenders: DashboardGraphRenderEntry[];
  proofPolicy: Record<string, unknown> & { dashboardNote?: string };
  baselineBranchStatus: string;
  generalizedBranchStatus: string;
  baselineFamilyAuthorityStatus: string;
  generalizedFamilyAuthorityStatus: string;
  baselineTransportCertificationStatus: string;
  generalizedTransportCertificationStatus: string;
  sourceMechanismPromotionContractStatus: string;
  sourceMechanismSelectedPromotionRoute: string;
  sourceMechanismExemptionRouteActivated: boolean;
  sourceMechanismNonAuthoritative: boolean;
  sourceMechanismFormulaEquivalent: boolean;
  sourceMechanismParityRouteStatus: string;
  sourceMechanismParityRouteBlockingClass: string;
  sourceMechanismActiveClaimSet: string[];
  sourceMechanismBlockedClaimSet: string[];
  sourceMechanismForbiddenPromotions: string[];
  sourceMechanismReferenceOnlyScope: boolean;
  sourceMechanismConsumerSummary: string;
  sourceMechanismConsumerConformance?: SourceMechanismConsumerConformanceSummary;
  comparisonSemantics: {
    crossCaseSourceMismatchCount: number;
    wallSafetySourceParity: boolean;
    cabinGravityUsesAnalyticCompanion: boolean;
  };
  panels: DashboardPanel[];
  badgeLegend: BadgeDefinition[];
  provenanceWarnings: Array<Record<string, unknown>>;
  recommendedReadingOrder: DashboardPanelId[];
};

type DashboardSeed = Omit<
  DashboardPayload,
  | "dashboardSurfaceKind"
  | "dashboardLayoutVersion"
  | "layoutBudget"
  | "renderedCardFamilyStatus"
  | "renderedCardReadingOrder"
  | "primaryRenderedCardId"
  | "renderedCards"
  | "legacyMonolithicCardStatus"
  | "legacyMonolithicCardPath"
  | "renderedCardStatus"
  | "renderedCardPath"
  | "renderedCardHash"
  | "renderedCardCategory"
  | "renderedCardRole"
  | "renderedCardLayoutVersion"
  | "graphRenderStatus"
  | "graphReadingOrder"
  | "graphRenders"
>;

type DashboardRenderedCardSource = {
  cardId: DashboardCardId;
  title: string;
  sectionSource: string;
  primary: boolean;
  svg: string;
  inspectionText: string;
};

type DashboardRenderedGraphSource = {
  graphId: DashboardGraphId;
  title: string;
  sourcePanel: DashboardPanelId;
  svg: string;
  inspectionText: string;
};

type CardSpec = {
  cardId: DashboardCardId;
  title: string;
  sectionSource: string;
  width: number;
  primary: boolean;
  variant: string;
  minHeight: number;
  question: string;
};

type GraphSpec = {
  graphId: DashboardGraphId;
  title: string;
  sourcePanel: DashboardPanelId;
  width: number;
  minHeight: number;
  variant: "graph";
  question: string;
};

type TextStyle = {
  fontSize: number;
  fontWeight: number;
  lineHeight: number;
  fill: string;
};

type RenderTaxonomyArtifact = any;

type RenderTaxonomyEntry = {
  renderId: string;
  caseId: string;
  renderCategory: string;
  renderRole: string;
  fieldId: string;
  variant: string;
  canonicalPath: string | null;
  legacyPath: string | null;
  authoritativeStatus: string;
  primaryScientificQuestion: string;
  baseImagePolicy: string;
  baseImageSource: string;
  inheritsTransportContext: boolean;
  contextCompositionMode: string;
  title: string;
  subtitle: string;
  quantitySymbol: string;
  quantityUnits: string;
  observer: string | null;
  foliation: string | null;
  signConvention: string | null;
  laneId: string | null;
  displayPolicyId: string | null;
  displayRangeMin: number | null;
  displayRangeMax: number | null;
  displayTransform: string | null;
  colormapFamily: string | null;
  cameraPoseId: string | null;
  orientationConventionId: string;
};

const TEXT: Record<string, TextStyle> = {
  headerTitle: { fontSize: 34, fontWeight: 800, lineHeight: 40, fill: "#f6f1e8" },
  headerSubtitle: { fontSize: 15, fontWeight: 600, lineHeight: 22, fill: "#d5dde6" },
  headerMeta: { fontSize: 13, fontWeight: 500, lineHeight: 18, fill: "#d5dde6" },
  sectionTitle: { fontSize: 24, fontWeight: 800, lineHeight: 30, fill: "#10233b" },
  sectionPurpose: { fontSize: 14, fontWeight: 600, lineHeight: 20, fill: "#405160" },
  note: { fontSize: 13, fontWeight: 500, lineHeight: 18, fill: "#5a6270" },
  body: { fontSize: 14, fontWeight: 500, lineHeight: 20, fill: "#334150" },
  bodyBold: { fontSize: 14, fontWeight: 700, lineHeight: 20, fill: "#10233b" },
  rowLabel: { fontSize: 18, fontWeight: 800, lineHeight: 24, fill: "#10233b" },
  rowUnits: { fontSize: 12, fontWeight: 600, lineHeight: 16, fill: "#6a7280" },
  blockCaption: { fontSize: 11, fontWeight: 800, lineHeight: 14, fill: "#586270" },
  blockValue: { fontSize: 18, fontWeight: 800, lineHeight: 24, fill: "#10233b" },
  blockValueSmall: { fontSize: 16, fontWeight: 700, lineHeight: 22, fill: "#10233b" },
  badge: { fontSize: 12, fontWeight: 700, lineHeight: 16, fill: "#10233b" },
  legendBody: { fontSize: 12, fontWeight: 500, lineHeight: 16, fill: "#334150" },
  warningTitle: { fontSize: 18, fontWeight: 800, lineHeight: 24, fill: "#10233b" },
};

const BADGES: BadgeDefinition[] = [
  {
    badgeId: "lane_a_unchanged",
    label: "Lane A unchanged",
    meaning:
      "The authoritative York proof surface remains unchanged and still governs formal comparison.",
    displayPriority: 1,
  },
  {
    badgeId: "reference_only",
    label: "reference_only",
    meaning:
      "This badge marks reference_only or fail-closed boundaries. For nhm2_shift_lapse, proof-bearing bounded transport publication is controlled separately by the authoritative shift-lapse transport-promotion gate; this dashboard does not claim that gate-passed publication.",
    displayPriority: 2,
  },
  {
    badgeId: "raw_brick",
    label: "raw brick",
    meaning:
      "The displayed value comes directly from the float32 GR evolve brick or a brick-derived summary.",
    displayPriority: 3,
  },
  {
    badgeId: "analytic_companion",
    label: "analytic companion",
    meaning:
      "The displayed value uses the analytic lapse-summary companion because the mild reference under-resolves in float32 brick channels.",
    displayPriority: 4,
  },
  {
    badgeId: "mixed_source",
    label: "mixed source",
    meaning:
      "The comparison row mixes raw-brick baseline values with analytic-companion generalized values; read it as conceptually aligned, not numerically identical pipelines.",
    displayPriority: 5,
  },
  {
    badgeId: "source_mismatch",
    label: "source mismatch",
    meaning:
      "Baseline and generalized values do not share the same numeric provenance and should be read with the listed source kinds.",
    displayPriority: 6,
  },
  {
    badgeId: "wall_safety_brick_derived",
    label: "wall safety brick-derived",
    meaning:
      "Wall-normal and bulk shift/lapse safety rows remain brick-derived in the current comparison.",
    displayPriority: 7,
  },
  {
    badgeId: "unresolved",
    label: "unresolved",
    meaning:
      "A nested supporting diagnostic remains unavailable or unresolved and is not being represented as analytic fallback.",
    displayPriority: 8,
  },
];

const BADGE_STYLE: Record<string, { fill: string; stroke: string; text: string }> = {
  lane_a_unchanged: { fill: "#d7efe0", stroke: "#2d6a4f", text: "#163828" },
  reference_only: { fill: "#f6e6bf", stroke: "#8a5a00", text: "#5b3a00" },
  raw_brick: { fill: "#d8e6f2", stroke: "#295a7a", text: "#17394d" },
  analytic_companion: { fill: "#f2d9e2", stroke: "#8d3a5e", text: "#561f39" },
  mixed_source: { fill: "#f4dfc3", stroke: "#8b5e1a", text: "#5c3d0f" },
  source_mismatch: { fill: "#f7d7d7", stroke: "#a33a3a", text: "#651f1f" },
  wall_safety_brick_derived: { fill: "#d2efea", stroke: "#1d6b67", text: "#124846" },
  unresolved: { fill: "#e4e7eb", stroke: "#5e6b78", text: "#39424b" },
};

const CARD_SPECS: CardSpec[] = [
  {
    cardId: "dashboard_overview",
    title: "Diagnostics Dashboard Overview",
    sectionSource: "dashboard_summary",
    width: 1320,
    primary: true,
    variant: "dashboard_overview",
    minHeight: 760,
    question:
      "How should a reviewer navigate the proof hierarchy, cabin gravity, wall safety, and provenance caveats for mild shift-plus-lapse NHM2?",
  },
  {
    cardId: "proof_status",
    title: "Proof Status",
    sectionSource: "proof_status_panel",
    width: 1180,
    primary: false,
    variant: "proof_status",
    minHeight: 520,
    question:
      "What proof hierarchy applies before reading any generalized shift-plus-lapse diagnostic row?",
  },
  {
    cardId: "cabin_gravity",
    title: "Cabin Gravity",
    sectionSource: "cabin_gravity_panel",
    width: 1480,
    primary: false,
    variant: "cabin_gravity",
    minHeight: 1080,
    question:
      "How do local lapse diagnostics differ from the unit-lapse baseline while keeping source provenance explicit?",
  },
  {
    cardId: "wall_safety",
    title: "Wall Safety",
    sectionSource: "wall_safety_panel",
    width: 1320,
    primary: false,
    variant: "wall_safety",
    minHeight: 720,
    question:
      "How do brick-derived wall-safety diagnostics compare between the unit-lapse baseline and the mild generalized branch?",
  },
  {
    cardId: "precision_provenance",
    title: "Precision / Provenance",
    sectionSource: "precision_panel",
    width: 1480,
    primary: false,
    variant: "precision_provenance",
    minHeight: 1120,
    question:
      "Where do mixed-source and unresolved provenance conditions affect the mild shift-plus-lapse comparison?",
  },
];

const GRAPH_SPECS: GraphSpec[] = [
  {
    graphId: "cabin_gravity_profile_z",
    title: "Local Cabin Gravity Profile",
    sourcePanel: "cabin_gravity_panel",
    width: 1320,
    minHeight: 860,
    variant: "graph",
    question:
      "How does local cabin gravity vary along the cabin axis in the mild shift-plus-lapse branch versus the unit-lapse baseline?",
  },
  {
    graphId: "clock_gradient_profile_z",
    title: "Local Clock Gradient Profile",
    sourcePanel: "cabin_gravity_panel",
    width: 1320,
    minHeight: 880,
    variant: "graph",
    question:
      "How small is the local clock-gradient profile across the cabin in the mild shift-plus-lapse branch versus the unit-lapse baseline?",
  },
];

const CABIN_ROW_IDS = [
  "alphaCenterline",
  "alphaGradientVec_m_inv",
  "centerline_dtau_dt",
  "cabin_clock_split_per_day_s",
  "cabin_gravity_gradient_si",
] as const;

const WALL_ROW_IDS = [
  "betaOverAlphaMax",
  "betaOutwardOverAlphaWallMax",
  "wallHorizonMargin",
] as const;

const METRICS_CANVAS = createCanvas(128, 128);
const METRICS_CTX = METRICS_CANVAS.getContext("2d");

const DASHBOARD_FIELD_FAMILY = {
  fieldId: "diagnostics_dashboard",
  label: "Diagnostics dashboard",
  quantitySymbol: "diagnostic dashboard",
  quantityUnits: "n/a",
  defaultCategory: "comparison_panel",
  defaultRole: "presentation",
  primaryScientificQuestion:
    "How does mild shift-plus-lapse NHM2 compare to the unit-lapse baseline while preserving provenance and proof hierarchy?",
  defaultDisplayPolicyId: null,
  defaultDisplayTransform: null,
  defaultColormapFamily: null,
};

const DASHBOARD_GRAPH_FIELD_FAMILIES = [
  {
    fieldId: "cabin_gravity_profile_z",
    label: "Cabin gravity profile z",
    quantitySymbol: "g_local(z)",
    quantityUnits: "m/s^2",
    defaultCategory: "comparison_panel",
    defaultRole: "presentation",
    primaryScientificQuestion:
      "How does local cabin gravity vary along the cabin axis in the mild shift-plus-lapse branch versus the unit-lapse baseline?",
    defaultDisplayPolicyId: null,
    defaultDisplayTransform: null,
    defaultColormapFamily: null,
  },
  {
    fieldId: "clock_gradient_profile_z",
    label: "Clock gradient profile z",
    quantitySymbol: "delta_tau_per_day(z)",
    quantityUnits: "s/day",
    defaultCategory: "comparison_panel",
    defaultRole: "presentation",
    primaryScientificQuestion:
      "How small is the local clock-gradient profile across the cabin in the mild shift-plus-lapse branch versus the unit-lapse baseline?",
    defaultDisplayPolicyId: null,
    defaultDisplayTransform: null,
    defaultColormapFamily: null,
  },
] as const;

const normalizePath = (value: string) => value.replaceAll("\\", "/");
const ensureDirForFile = (filePath: string) =>
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
const sha256 = (value: string | Buffer) =>
  crypto.createHash("sha256").update(value).digest("hex");
const readJsonFile = <T = any>(filePath: string): T =>
  JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
const fontSpec = (style: TextStyle) =>
  `${style.fontWeight} ${style.fontSize}px ${FONT_FAMILY}`;
const findQuantity = (section: any, quantityId: string) =>
  section?.quantities?.find((q: any) => q.quantityId === quantityId);
const panelById = (payload: { panels: DashboardPanel[] }, panelId: DashboardPanelId) =>
  payload.panels.find((panel) => panel.panelId === panelId)!;
const cardSpecById = (cardId: DashboardCardId) =>
  CARD_SPECS.find((entry) => entry.cardId === cardId)!;
const graphSpecById = (graphId: DashboardGraphId) =>
  GRAPH_SPECS.find((entry) => entry.graphId === graphId)!;
const buildCardAbsolutePath = (cardId: DashboardCardId) =>
  path.join(OUT_RENDER_DIR, `nhm2_shift_lapse-comparison_panel-${cardId}-card.png`);
const buildGraphAbsolutePath = (graphId: DashboardGraphId) =>
  path.join(OUT_RENDER_DIR, `nhm2_shift_lapse-comparison_panel-${graphId}-graph.png`);
const escapeXml = (value: unknown) =>
  `${value ?? ""}`
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const normalizeShiftLapseTransportNarrative = (value: string): string =>
  value
    .replaceAll(
      "bounded transport proof-bearing surfaces remain fail-closed and reference-only",
      "proof-bearing bounded transport admission remains separately controlled by the authoritative shift-lapse transport-promotion gate",
    )
    .replaceAll(
      "bounded transport proof-bearing surfaces remain fail-closed/reference-only",
      "proof-bearing bounded transport admission remains separately controlled by the authoritative shift-lapse transport-promotion gate",
    )
    .replaceAll(
      "bounded transport proof-bearing surfaces remain fail-closed and reference_only",
      "proof-bearing bounded transport admission remains separately controlled by the authoritative shift-lapse transport-promotion gate",
    )
    .replaceAll(
      "bounded transport proof-bearing surfaces remain fail-closed/reference_only",
      "proof-bearing bounded transport admission remains separately controlled by the authoritative shift-lapse transport-promotion gate",
    )
    .replaceAll(
      "and its bounded transport proof-bearing surfaces remain fail-closed and reference_only.",
      "and proof-bearing bounded transport admission remains controlled separately by the authoritative shift-lapse transport-promotion gate rather than granted by this source/mechanism surface.",
    );

const loadSourceMechanismPolicyContext = (): SourceMechanismPolicyContext => {
  const promotionArtifact = readJsonFile<any>(SOURCE_MECHANISM_PROMOTION_CONTRACT_LATEST_JSON);
  const maturityArtifact = readJsonFile<any>(SOURCE_MECHANISM_MATURITY_LATEST_JSON);
  const formulaArtifact = readJsonFile<any>(SOURCE_FORMULA_AUDIT_LATEST_JSON);
  const parityArtifact = readJsonFile<any>(SOURCE_MECHANISM_PARITY_ROUTE_LATEST_JSON);
  const contract = promotionArtifact.sourceMechanismPromotionContract;
  const maturity = maturityArtifact.sourceMechanismMaturity;
  const formulaComparison = formulaArtifact.formulaComparison;
  const parity = parityArtifact.sourceMechanismParityRouteFeasibility;
  return {
    contractStatus: contract.contractStatus,
    selectedPromotionRoute: contract.selectedPromotionRoute,
    exemptionRouteActivated: contract.exemptionRouteActivated === true,
    nonAuthoritative: maturity.authoritativeStatus === "non_authoritative",
    formulaEquivalent: formulaComparison.formulaEquivalent === true,
    parityRouteStatus: parity.feasibilityStatus,
    parityRouteBlockingClass: parity.routeBlockingClass,
    activeClaimSet: [...contract.activeClaimSet],
    blockedClaimSet: [...contract.inactiveClaimSet],
    forbiddenPromotions: [...contract.forbiddenPromotions],
    requiredDisclaimers: [...contract.activationDisclaimers],
    referenceOnlyScope: contract.referenceOnlyCrossLaneScope === true,
    consumerSummary: normalizeShiftLapseTransportNarrative(contract.consumerSummary),
  };
};

const formatNumber = (value: number): string => {
  const abs = Math.abs(value);
  if (abs === 0) return "0";
  if (abs >= 1e4 || abs < 1e-3) return value.toExponential(3).replace(/e\+?/, "e");
  if (Number.isInteger(value) && abs < 1e4) return `${value}`;
  const fixed =
    abs >= 100 ? value.toFixed(2) : abs >= 1 ? value.toFixed(6) : value.toFixed(8);
  return fixed.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
};

const formatValue = (value: unknown, signed = false): string => {
  if (value == null) return "n/a";
  if (Array.isArray(value)) {
    return `[${value.map((entry) => formatValue(entry)).join(", ")}]`;
  }
  if (typeof value === "number") {
    const text = formatNumber(value);
    return signed && value > 0 ? `+${text}` : text;
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  return `${value}`;
};

const measureTextWidth = (value: string, style: TextStyle) => {
  METRICS_CTX.font = fontSpec(style);
  return METRICS_CTX.measureText(value).width;
};

const splitLongTokenToWidth = (
  token: string,
  maxWidth: number,
  style: TextStyle,
): string[] => {
  if (measureTextWidth(token, style) <= maxWidth) return [token];
  const parts: string[] = [];
  let current = "";
  for (const char of token) {
    const candidate = `${current}${char}`;
    if (current && measureTextWidth(candidate, style) > maxWidth) {
      parts.push(current);
      current = char;
    } else {
      current = candidate;
    }
  }
  if (current) parts.push(current);
  return parts;
};

const wrapText = (value: string, maxWidth: number, style: TextStyle): string[] => {
  const normalized = value.trim();
  if (!normalized) return [""];
  const words = normalized.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    for (const part of splitLongTokenToWidth(word, maxWidth, style)) {
      const candidate = current ? `${current} ${part}` : part;
      if (current && measureTextWidth(candidate, style) > maxWidth) {
        lines.push(current);
        current = part;
      } else if (!current && measureTextWidth(part, style) > maxWidth) {
        lines.push(part);
        current = "";
      } else {
        current = candidate;
      }
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [normalized];
};

const renderTextLines = (
  lines: string[],
  x: number,
  y: number,
  style: TextStyle,
  textAnchor: "start" | "middle" | "end" = "start",
) => ({
  svg: lines
    .map(
      (line, index) =>
        `<text x="${x}" y="${y + index * style.lineHeight}" fill="${style.fill}" font-size="${style.fontSize}" font-weight="${style.fontWeight}" font-family="${FONT_FAMILY}" text-anchor="${textAnchor}">${escapeXml(line)}</text>`,
    )
    .join(""),
  height: lines.length > 0 ? lines.length * style.lineHeight : 0,
});

const badgeLabel = (badgeId: string) =>
  BADGES.find((entry) => entry.badgeId === badgeId)?.label ?? badgeId;

const sourceBadgeIds = (sourceKind: string | null | undefined): string[] => {
  switch (sourceKind) {
    case "brick_float32_direct":
      return ["raw_brick"];
    case "analytic_lapse_summary_companion":
      return ["analytic_companion"];
    case "mixed_source_prefer_analytic_for_underflow":
      return ["mixed_source"];
    case "unresolved_gravity_gradient":
    case "unavailable":
      return ["unresolved"];
    default:
      return [];
  }
};

const uniqueBadgeIds = (ids: Array<string | null | undefined>) =>
  [...new Set(ids.filter((id): id is string => Boolean(id)))];

const axisComponentIndex = (axis: string) => {
  switch (axis) {
    case "x_ship":
      return 0;
    case "y_port":
      return 1;
    case "z_zenith":
    default:
      return 2;
  }
};

const evenlySpacedDomain = (min: number, max: number, count: number) => {
  if (count <= 1) return [min];
  const step = (max - min) / (count - 1);
  return Array.from({ length: count }, (_, index) => min + step * index);
};

const resolveCabinGraphAxis = (comparison: any) =>
  comparison.generalizedCase?.cabinObservables?.cabinSampleAxis ??
  comparison.generalizedCase?.alphaProfileMetadata?.alphaGradientAxis ??
  comparison.baselineCase?.cabinObservables?.cabinSampleAxis ??
  comparison.baselineCase?.alphaProfileMetadata?.alphaGradientAxis ??
  "z_zenith";

const resolveCabinHalfSpanM = (comparison: any) =>
  Math.max(
    1e-6,
    Number(
      comparison.generalizedCase?.cabinObservables?.cabinSampleSeparation_m ??
        comparison.baselineCase?.cabinObservables?.cabinSampleSeparation_m ??
        comparison.generalizedCase?.alphaProfileMetadata?.referenceCalibration
          ?.targetCabinHeight_m ??
        comparison.baselineCase?.alphaProfileMetadata?.referenceCalibration
          ?.targetCabinHeight_m ??
        2.5,
    ) * 0.5,
  );

const buildAlphaProfileSeries = (caseEntry: any, sampleAxis: string, sampleDomain: number[]) => {
  const centerlineAlpha = Number(
    caseEntry?.alphaProfileMetadata?.alphaCenterline ??
      caseEntry?.cabinObservables?.centerline_alpha ??
      1,
  );
  const gradientVector = Array.isArray(caseEntry?.alphaProfileMetadata?.alphaGradientVec_m_inv)
    ? caseEntry.alphaProfileMetadata.alphaGradientVec_m_inv
    : [0, 0, 0];
  const gradientIndex = axisComponentIndex(sampleAxis);
  const gradientComponent = Number(gradientVector[gradientIndex] ?? 0);
  return sampleDomain.map((position) => centerlineAlpha * Math.exp(gradientComponent * position));
};

const buildGravityProfileSeries = (caseEntry: any, sampleDomain: number[]) => {
  const gravitySi = Number(caseEntry?.cabinObservables?.cabin_gravity_gradient_si ?? 0);
  return sampleDomain.map(() => gravitySi);
};

const buildClockGradientSeries = (caseEntry: any, sampleAxis: string, sampleDomain: number[]) => {
  const alphaSeries = buildAlphaProfileSeries(caseEntry, sampleAxis, sampleDomain);
  const centerlineAlpha = Number(
    caseEntry?.alphaProfileMetadata?.alphaCenterline ??
      caseEntry?.cabinObservables?.centerline_alpha ??
      1,
  );
  return alphaSeries.map((alpha) => ((alpha / Math.max(centerlineAlpha, 1e-30)) - 1) * SECONDS_PER_DAY);
};

const buildDashboardGraphSeriesBlocks = (comparison: any): DashboardGraphSeriesBlock[] => {
  const sampleAxis = resolveCabinGraphAxis(comparison);
  const halfSpanM = resolveCabinHalfSpanM(comparison);
  const sampleDomain = evenlySpacedDomain(-halfSpanM, halfSpanM, GRAPH_SAMPLE_COUNT);
  const underResolutionDetected = comparison.generalizedPrecisionContext?.underResolutionDetected === true;
  const gravityQuantity = findQuantity(
    comparison.cabinGravityComparison,
    "cabin_gravity_gradient_si",
  );
  const clockQuantity = findQuantity(
    comparison.cabinGravityComparison,
    "cabin_clock_split_per_day_s",
  );
  const gravitySharedBadges = uniqueBadgeIds([
    gravityQuantity?.crossCaseSourceMismatch ? "mixed_source" : null,
    gravityQuantity?.crossCaseSourceMismatch ? "source_mismatch" : null,
  ]);
  const clockSharedBadges = uniqueBadgeIds([
    clockQuantity?.crossCaseSourceMismatch ? "mixed_source" : null,
    clockQuantity?.crossCaseSourceMismatch ? "source_mismatch" : null,
  ]);
  return [
    {
      graphId: "cabin_gravity_profile_z",
      title: "Local Cabin Gravity Profile Along z_zenith",
      quantitySymbol: "g_local(z)",
      quantityUnits: "m/s^2",
      sampleAxis,
      sampleAxisLabel: `Cabin ${sampleAxis} offset (m)`,
      sampleDomain,
      sampleCount: sampleDomain.length,
      baselineSeries: buildGravityProfileSeries(comparison.baselineCase, sampleDomain),
      generalizedSeries: buildGravityProfileSeries(comparison.generalizedCase, sampleDomain),
      baselineSourceKind: gravityQuantity?.baselineSourceKind ?? "brick_float32_direct",
      generalizedSourceKind:
        gravityQuantity?.generalizedSourceKind ?? "analytic_lapse_summary_companion",
      baselineSeriesStatus: "sampled_raw_brick_constant_axis_profile",
      generalizedSeriesStatus:
        "sampled_analytic_companion_constant_log_gradient_profile",
      baselineBadgeIds: sourceBadgeIds(gravityQuantity?.baselineSourceKind),
      generalizedBadgeIds: sourceBadgeIds(gravityQuantity?.generalizedSourceKind),
      sharedBadgeIds: gravitySharedBadges,
      underResolutionDetected,
      graphNote:
        "Local cabin gravity proxy only. Baseline remains the raw-brick unit-lapse zero profile. The mild shift-plus-lapse branch uses the analytic companion lapse summary because float32 raw channels under-resolve the lapse gradient. Presentation-only graph; not a proof surface and not a wall-safety score.",
    },
    {
      graphId: "clock_gradient_profile_z",
      title: "Local Clock Gradient Profile Along z_zenith",
      quantitySymbol: "delta_tau_per_day(z)",
      quantityUnits: "s/day",
      sampleAxis,
      sampleAxisLabel: `Cabin ${sampleAxis} offset (m)`,
      sampleDomain,
      sampleCount: sampleDomain.length,
      baselineSeries: buildClockGradientSeries(
        comparison.baselineCase,
        sampleAxis,
        sampleDomain,
      ),
      generalizedSeries: buildClockGradientSeries(
        comparison.generalizedCase,
        sampleAxis,
        sampleDomain,
      ),
      baselineSourceKind: clockQuantity?.baselineSourceKind ?? "brick_float32_direct",
      generalizedSourceKind:
        clockQuantity?.generalizedSourceKind ?? "analytic_lapse_summary_companion",
      baselineSeriesStatus: "sampled_raw_brick_centerline_relative_profile",
      generalizedSeriesStatus:
        "sampled_analytic_companion_centerline_relative_profile",
      baselineBadgeIds: sourceBadgeIds(clockQuantity?.baselineSourceKind),
      generalizedBadgeIds: sourceBadgeIds(clockQuantity?.generalizedSourceKind),
      sharedBadgeIds: clockSharedBadges,
      underResolutionDetected,
      graphNote:
        "Local cabin clock gradient relative to the centerline only. The mild shift-plus-lapse branch is reconstructed from the analytic companion lapse summary because float32 raw channels under-resolve the lapse gradient. This is not route-time compression. Scientific notation is intentional so the tiny scale stays visually honest.",
    },
  ];
};

const measureBadgeWidth = (label: string) =>
  Math.max(92, measureTextWidth(label, TEXT.badge) + 24);

const renderBadgeStrip = (
  badgeIds: string[],
  x: number,
  y: number,
  maxWidth: number,
) => {
  const ids = uniqueBadgeIds(badgeIds);
  if (ids.length === 0) return { svg: "", height: 0 };
  let cursorX = x;
  let cursorY = y;
  const parts: string[] = [];
  for (const badgeId of ids) {
    const label = badgeLabel(badgeId);
    const style = BADGE_STYLE[badgeId] ?? BADGE_STYLE.unresolved;
    const width = measureBadgeWidth(label);
    if (cursorX !== x && cursorX + width > x + maxWidth) {
      cursorX = x;
      cursorY += BADGE_HEIGHT + BADGE_GAP;
    }
    parts.push(
      `<rect x="${cursorX}" y="${cursorY}" width="${width}" height="${BADGE_HEIGHT}" rx="14" fill="${style.fill}" stroke="${style.stroke}" stroke-width="1.5" />`,
      `<text x="${cursorX + width / 2}" y="${cursorY + 19}" fill="${style.text}" font-size="${TEXT.badge.fontSize}" font-weight="${TEXT.badge.fontWeight}" font-family="${FONT_FAMILY}" text-anchor="middle">${escapeXml(label)}</text>`,
    );
    cursorX += width + BADGE_GAP;
  }
  return { svg: parts.join(""), height: cursorY - y + BADGE_HEIGHT };
};

const rowBadgeBundles = (row: DashboardRow) => {
  const baselineSourceBadges = sourceBadgeIds(row.baselineSourceKind);
  const generalizedSourceBadges = sourceBadgeIds(row.generalizedSourceKind);
  const extraBadges = uniqueBadgeIds(
    row.badgeIds.filter(
      (badgeId) =>
        !baselineSourceBadges.includes(badgeId) &&
        !generalizedSourceBadges.includes(badgeId),
    ),
  );
  return { baselineSourceBadges, generalizedSourceBadges, extraBadges };
};

const buildDashboardRow = (
  quantity: any,
  panelId: "cabin_gravity_panel" | "wall_safety_panel",
): DashboardRow => {
  const badgeIds = new Set<string>();
  let badgeId = "raw_brick";
  if (panelId === "wall_safety_panel") {
    badgeId = "wall_safety_brick_derived";
    badgeIds.add("wall_safety_brick_derived");
  } else if (quantity.crossCaseSourceMismatch) {
    badgeId = "mixed_source";
    badgeIds.add("mixed_source");
    badgeIds.add("source_mismatch");
  } else if (
    quantity.generalizedSourceKind === "analytic_lapse_summary_companion" ||
    quantity.baselineSourceKind === "analytic_lapse_summary_companion"
  ) {
    badgeId = "analytic_companion";
    badgeIds.add("analytic_companion");
  } else {
    badgeId = "raw_brick";
    badgeIds.add("raw_brick");
  }
  if (quantity.crossCaseSourceMismatch) badgeIds.add("source_mismatch");
  const defaultNote =
    panelId === "wall_safety_panel"
      ? "Wall safety remains a brick-derived combined shift/lapse horizon proxy and is not a comfort score."
      : quantity.crossCaseSourceMismatch
        ? "Generalized mild-reference value uses analytic-companion reporting under float32 under-resolution."
        : "Row is directly comparable without a cross-case source mismatch.";
  return {
    rowId: quantity.quantityId,
    label: quantity.label,
    baselineValue: quantity.baselineValue,
    generalizedValue: quantity.generalizedValue,
    units: quantity.units,
    delta: quantity.delta,
    baselineSourceKind: quantity.baselineSourceKind,
    generalizedSourceKind: quantity.generalizedSourceKind,
    badgeId,
    badgeIds: [...badgeIds],
    crossCaseSourceMismatch: Boolean(quantity.crossCaseSourceMismatch),
    note: quantity.note ?? defaultNote,
  };
};

const buildProofRows = (comparison: any): DashboardRow[] => [
  {
    rowId: "authoritative_proof_surface",
    label: "Authoritative Proof Surface",
    baselineValue: comparison.proofPolicy.authoritativeProofSurface,
    generalizedValue: comparison.proofPolicy.authoritativeProofSurface,
    units: "status",
    delta: "unchanged",
    baselineSourceKind: "comparison_contract",
    generalizedSourceKind: "comparison_contract",
    badgeId: "lane_a_unchanged",
    badgeIds: ["lane_a_unchanged"],
    crossCaseSourceMismatch: false,
    note: "Lane A remains the proof surface for formal warp comparisons and class decisions.",
  },
  {
    rowId: "generalized_family_status",
    label: "Generalized Family Authority Status",
    baselineValue: comparison.baselineFamilyAuthorityStatus,
    generalizedValue: comparison.generalizedFamilyAuthorityStatus,
    units: "status",
    delta: "family_status_split",
    baselineSourceKind: "comparison_contract",
    generalizedSourceKind: "comparison_contract",
    badgeId: "lane_a_unchanged",
    badgeIds: ["lane_a_unchanged"],
    crossCaseSourceMismatch: false,
    note: "The generalized branch exists as a distinct candidate authoritative solve family in full-solve provenance/model-selection.",
  },
  {
    rowId: "generalized_transport_status",
    label: "Generalized Transport Certification Status",
    baselineValue: comparison.baselineTransportCertificationStatus,
    generalizedValue: comparison.generalizedTransportCertificationStatus,
    units: "status",
    delta: "transport_fail_closed",
    baselineSourceKind: "comparison_contract",
    generalizedSourceKind: "comparison_contract",
    badgeId: "reference_only",
    badgeIds: ["lane_a_unchanged", "reference_only"],
    crossCaseSourceMismatch: false,
    note: "The generalized family default transport certification status remains fail-closed/reference_only unless an explicitly selected solve passes the authoritative shift-lapse transport-promotion gate; this dashboard does not itself claim gate-passed proof-bearing transport publication.",
  },
];

const buildPrecisionRows = (comparison: any): DashboardRow[] => [
  {
    rowId: "crossCaseSourceMismatchCount",
    label: "Cross-Case Source Mismatch Count",
    baselineValue: 0,
    generalizedValue: comparison.comparisonSummary.crossCaseSourceMismatchCount,
    units: "count",
    delta: comparison.comparisonSummary.crossCaseSourceMismatchCount,
    baselineSourceKind: "comparison_summary",
    generalizedSourceKind: "comparison_summary",
    badgeId:
      comparison.comparisonSummary.crossCaseSourceMismatchCount > 0
        ? "source_mismatch"
        : "raw_brick",
    badgeIds:
      comparison.comparisonSummary.crossCaseSourceMismatchCount > 0
        ? ["mixed_source", "source_mismatch"]
        : ["raw_brick"],
    crossCaseSourceMismatch: false,
    note: "Counts the cabin-gravity rows where baseline and generalized provenance differ.",
  },
  {
    rowId: "wallSafetySourceParity",
    label: "Wall Safety Source Parity",
    baselineValue: comparison.baselinePrecisionContext.wallSafetySource,
    generalizedValue: comparison.generalizedPrecisionContext.wallSafetySource,
    units: "status",
    delta: comparison.comparisonSummary.wallSafetySourceParity ? "aligned" : "mixed",
    baselineSourceKind: "comparison_summary",
    generalizedSourceKind: "comparison_summary",
    badgeId: "wall_safety_brick_derived",
    badgeIds: ["wall_safety_brick_derived", "raw_brick"],
    crossCaseSourceMismatch: false,
    note: "Wall safety remains brick-derived in both cases.",
  },
  {
    rowId: "cabinGravitySourcePolicy",
    label: "Cabin Gravity Source Policy",
    baselineValue: comparison.baselinePrecisionContext.channelPrecisionPolicy,
    generalizedValue: comparison.generalizedPrecisionContext.channelPrecisionPolicy,
    units: "policy",
    delta: comparison.precisionComparisonStatus,
    baselineSourceKind: "comparison_summary",
    generalizedSourceKind: "comparison_summary",
    badgeId: "mixed_source",
    badgeIds: ["mixed_source", "source_mismatch"],
    crossCaseSourceMismatch: true,
    note: "The generalized mild reference intentionally prefers analytic companion reporting for under-resolved cabin/lapse diagnostics.",
  },
  {
    rowId: "baselineDirectPipelineNestedProvenance",
    label: "Baseline Nested Direct-Pipeline Provenance",
    baselineValue:
      comparison.baselineCase?.cabinObservables?.directPipelineCabinObservables?.details
        ?.source ?? null,
    generalizedValue: comparison.generalizedCase?.cabinObservables?.details?.source ?? null,
    units: "status",
    delta: "normalized",
    baselineSourceKind: "comparison_summary",
    generalizedSourceKind: "comparison_summary",
    badgeId: "unresolved",
    badgeIds: ["unresolved"],
    crossCaseSourceMismatch: false,
    note: "Baseline nested direct-pipeline cabin diagnostics are marked unresolved rather than analytic fallback when no analytic companion value exists.",
  },
];

const renderCardHeader = (
  width: number,
  title: string,
  subtitle: string,
  meta: string,
  badgeIds: string[],
) => {
  const innerWidth = width - CARD_MARGIN * 2;
  const titleSvg = renderTextLines(
    wrapText(title, innerWidth - 320, TEXT.headerTitle),
    CARD_MARGIN + 28,
    CARD_MARGIN + 40,
    TEXT.headerTitle,
  );
  const subtitleSvg = renderTextLines(
    wrapText(subtitle, innerWidth - 40, TEXT.headerSubtitle),
    CARD_MARGIN + 28,
    CARD_MARGIN + 40 + titleSvg.height,
    TEXT.headerSubtitle,
  );
  const metaSvg = renderTextLines(
    wrapText(meta, innerWidth - 40, TEXT.headerMeta),
    CARD_MARGIN + 28,
    CARD_MARGIN + 40 + titleSvg.height + subtitleSvg.height,
    TEXT.headerMeta,
  );
  const badgeSvg = renderBadgeStrip(
    badgeIds,
    CARD_MARGIN + innerWidth - HEADER_BADGE_WIDTH,
    CARD_MARGIN + 22,
    HEADER_BADGE_WIDTH,
  );
  return {
    svg: [
      `<rect x="${CARD_MARGIN}" y="${CARD_MARGIN}" width="${innerWidth}" height="${HEADER_HEIGHT}" rx="26" fill="#10233b" />`,
      titleSvg.svg,
      subtitleSvg.svg,
      metaSvg.svg,
      badgeSvg.svg,
    ].join(""),
    bodyY: CARD_MARGIN + HEADER_HEIGHT + SECTION_GAP,
  };
};

const renderIntroBox = (
  x: number,
  y: number,
  width: number,
  title: string,
  purpose: string,
  sectionNote: string,
) => {
  const titleSvg = renderTextLines([title], x + 20, y + 28, TEXT.sectionTitle);
  const purposeSvg = renderTextLines(
    wrapText(purpose, width - 40, TEXT.sectionPurpose),
    x + 20,
    y + 56,
    TEXT.sectionPurpose,
  );
  const noteSvg = renderTextLines(
    wrapText(sectionNote, width - 40, TEXT.note),
    x + 20,
    y + 56 + purposeSvg.height + 10,
    TEXT.note,
  );
  const height = 24 + titleSvg.height + 8 + purposeSvg.height + 10 + noteSvg.height + 20;
  return {
    svg: [
      `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="22" fill="#fffaf4" stroke="#d3c6b1" stroke-width="1.5" />`,
      `<rect x="${x}" y="${y}" width="${width}" height="6" fill="#12324a" rx="22" />`,
      titleSvg.svg,
      purposeSvg.svg,
      noteSvg.svg,
    ].join(""),
    height,
  };
};

const renderMetricBlock = (
  title: string,
  value: unknown,
  badgeIds: string[],
  x: number,
  y: number,
  width: number,
) => {
  const captionSvg = renderTextLines([title], x, y + 14, TEXT.blockCaption);
  const valueText = formatValue(value);
  const valueStyle =
    valueText.length > 28 ? TEXT.blockValueSmall : TEXT.blockValue;
  const valueSvg = renderTextLines(
    wrapText(valueText, width, valueStyle),
    x,
    y + 40,
    valueStyle,
  );
  const badgeSvg = renderBadgeStrip(
    badgeIds,
    x,
    y + 40 + valueSvg.height + 6,
    Math.max(width, LAYOUT_BUDGET.badgeWrapThreshold),
  );
  const height = 18 + valueSvg.height + (badgeSvg.height > 0 ? 8 + badgeSvg.height : 0);
  return { svg: `${captionSvg.svg}${valueSvg.svg}${badgeSvg.svg}`, height };
};

const renderMetricRow = (row: DashboardRow, x: number, y: number, width: number) => {
  const bundles = rowBadgeBundles(row);
  const labelSvg = renderTextLines(
    wrapText(row.label, width - ROW_PADDING * 2, TEXT.rowLabel),
    x + ROW_PADDING,
    y + ROW_PADDING + 8,
    TEXT.rowLabel,
  );
  const unitsSvg = renderTextLines(
    [`units: ${row.units}`],
    x + ROW_PADDING,
    y + ROW_PADDING + 8 + labelSvg.height + 4,
    TEXT.rowUnits,
  );
  const contentWidth = width - ROW_PADDING * 2;
  const columnGap = 18;
  const colWidth = Math.floor((contentWidth - columnGap * 2) / 3);
  const columnsY = y + ROW_PADDING + 8 + labelSvg.height + 4 + unitsSvg.height + 12;
  const baselineBlock = renderMetricBlock(
    "BASELINE",
    row.baselineValue,
    bundles.baselineSourceBadges,
    x + ROW_PADDING,
    columnsY,
    colWidth,
  );
  const generalizedBlock = renderMetricBlock(
    "GENERALIZED",
    row.generalizedValue,
    bundles.generalizedSourceBadges,
    x + ROW_PADDING + colWidth + columnGap,
    columnsY,
    colWidth,
  );
  const deltaBlock = renderMetricBlock(
    "DELTA / CHANGE",
    row.delta,
    bundles.extraBadges,
    x + ROW_PADDING + (colWidth + columnGap) * 2,
    columnsY,
    colWidth,
  );
  const columnsHeight = Math.max(
    baselineBlock.height,
    generalizedBlock.height,
    deltaBlock.height,
  );
  const noteTitleSvg = renderTextLines(
    ["NOTE"],
    x + ROW_PADDING,
    columnsY + columnsHeight + 18,
    TEXT.blockCaption,
  );
  const noteSvg = renderTextLines(
    wrapText(row.note, Math.min(contentWidth, LAYOUT_BUDGET.noteWrapWidth), TEXT.note),
    x + ROW_PADDING,
    columnsY + columnsHeight + 38,
    TEXT.note,
  );
  const totalHeight =
    ROW_PADDING +
    labelSvg.height +
    4 +
    unitsSvg.height +
    12 +
    columnsHeight +
    18 +
    noteTitleSvg.height +
    6 +
    noteSvg.height +
    ROW_PADDING;
  return {
    svg: [
      `<rect x="${x}" y="${y}" width="${width}" height="${totalHeight}" rx="20" fill="#fcf8f1" stroke="#dfd2bf" stroke-width="1.5" />`,
      labelSvg.svg,
      unitsSvg.svg,
      baselineBlock.svg,
      generalizedBlock.svg,
      deltaBlock.svg,
      noteTitleSvg.svg,
      noteSvg.svg,
    ].join(""),
    height: totalHeight,
  };
};

const renderWarningList = (
  warnings: Array<Record<string, unknown>>,
  x: number,
  y: number,
  width: number,
) => {
  const titleSvg = renderTextLines(
    ["Provenance Warnings"],
    x + 20,
    y + 30,
    TEXT.warningTitle,
  );
  let currentY = y + 60;
  const elements: string[] = [];
  for (const warning of warnings) {
    const body = `${warning.quantityId}: ${warning.note}`;
    const bodySvg = renderTextLines(
      wrapText(body, width - 40, TEXT.note),
      x + 20,
      currentY,
      TEXT.note,
    );
    elements.push(bodySvg.svg);
    currentY += bodySvg.height + 10;
  }
  const height = Math.max(90, currentY - y + 12);
  return {
    svg: [
      `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="20" fill="#fffaf4" stroke="#d3c6b1" stroke-width="1.5" />`,
      titleSvg.svg,
      ...elements,
    ].join(""),
    height,
  };
};

const renderBadgeLegendBlock = (
  badges: BadgeDefinition[],
  x: number,
  y: number,
  width: number,
) => {
  const titleSvg = renderTextLines(["Badge Legend"], x + 20, y + 30, TEXT.warningTitle);
  const introSvg = renderTextLines(
    wrapText(
      "Badges remain visible inline on each row. This legend is a secondary reference for badge meaning only.",
      width - 40,
      TEXT.note,
    ),
    x + 20,
    y + 56,
    TEXT.note,
  );
  let currentY = y + 56 + introSvg.height + 10;
  const elements: string[] = [];
  for (const badge of badges.slice().sort((a, b) => a.displayPriority - b.displayPriority)) {
    const badgeSvg = renderBadgeStrip([badge.badgeId], x + 20, currentY, width - 40);
    const meaningSvg = renderTextLines(
      wrapText(badge.meaning, width - 40, TEXT.legendBody),
      x + 20,
      currentY + badgeSvg.height + 8,
      TEXT.legendBody,
    );
    elements.push(badgeSvg.svg, meaningSvg.svg);
    currentY += badgeSvg.height + 8 + meaningSvg.height + 12;
  }
  const height = currentY - y + 8;
  return {
    svg: [
      `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="20" fill="#fffaf4" stroke="#d3c6b1" stroke-width="1.5" />`,
      titleSvg.svg,
      introSvg.svg,
      ...elements,
    ].join(""),
    height,
  };
};

const renderSummaryTile = (
  label: string,
  value: string,
  note: string,
  badgeIds: string[],
  x: number,
  y: number,
  width: number,
) => {
  const labelSvg = renderTextLines([label], x + 18, y + 26, TEXT.blockCaption);
  const valueStyle = value.length > 34 ? TEXT.blockValueSmall : TEXT.blockValue;
  const valueSvg = renderTextLines(
    wrapText(value, width - 36, valueStyle),
    x + 18,
    y + 50,
    valueStyle,
  );
  const badgeSvg = renderBadgeStrip(badgeIds, x + 18, y + 54 + valueSvg.height, width - 36);
  const noteSvg = renderTextLines(
    wrapText(note, width - 36, TEXT.note),
    x + 18,
    y + 54 + valueSvg.height + (badgeSvg.height > 0 ? badgeSvg.height + 10 : 0),
    TEXT.note,
  );
  const height =
    20 +
    labelSvg.height +
    8 +
    valueSvg.height +
    (badgeSvg.height > 0 ? badgeSvg.height + 10 : 0) +
    noteSvg.height +
    18;
  return {
    svg: [
      `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="18" fill="#fcf8f1" stroke="#dfd2bf" stroke-width="1.5" />`,
      labelSvg.svg,
      valueSvg.svg,
      badgeSvg.svg,
      noteSvg.svg,
    ].join(""),
    height,
  };
};

const renderCompanionCardList = (
  cards: CardSpec[],
  x: number,
  y: number,
  width: number,
) => {
  const titleSvg = renderTextLines(
    ["Companion Cards"],
    x + 20,
    y + 30,
    TEXT.warningTitle,
  );
  let currentY = y + 60;
  const elements: string[] = [];
  for (const card of cards) {
    const body = `${card.title}: ${
      card.sectionSource === "dashboard_summary"
        ? "index the card family"
        : `driven by ${card.sectionSource}`
    }.`;
    const bulletSvg = renderTextLines(["•"], x + 20, currentY, TEXT.bodyBold);
    const bodySvg = renderTextLines(
      wrapText(body, width - 50, TEXT.body),
      x + 38,
      currentY,
      TEXT.body,
    );
    elements.push(bulletSvg.svg, bodySvg.svg);
    currentY += bodySvg.height + 10;
  }
  const height = currentY - y + 12;
  return {
    svg: [
      `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="20" fill="#fffaf4" stroke="#d3c6b1" stroke-width="1.5" />`,
      titleSvg.svg,
      ...elements,
    ].join(""),
    height,
  };
};

const renderOverviewCard = (payload: DashboardSeed, spec: CardSpec) => {
  const width = spec.width;
  const innerWidth = width - CARD_MARGIN * 2;
  const header = renderCardHeader(
    width,
    "NHM2 Shift+Lapse Dashboard Overview",
    "Unit-lapse NHM2 baseline vs mild shift-plus-lapse reference | candidate family shown, transport admission gate-controlled",
    `scenario=${payload.scenarioId} | crossCaseSourceMismatchCount=${payload.comparisonSemantics.crossCaseSourceMismatchCount} | wallSafetySourceParity=${payload.comparisonSemantics.wallSafetySourceParity ? "true" : "false"}`,
    ["lane_a_unchanged", "reference_only"],
  );
  let currentY = header.bodyY;
  const elements: string[] = [];
  const intro = renderIntroBox(
    CARD_MARGIN,
    currentY,
    innerWidth,
    "Dashboard Overview",
    "Use this index card to route a reviewer to the proof-status, cabin-gravity, wall-safety, and precision/provenance cards without re-deriving the comparison semantics.",
    "This overview card is not the proof surface. It summarizes the card family while keeping Lane A authoritative, presenting nhm2_shift_lapse as a candidate authoritative solve family, and treating proof-bearing bounded transport admission as separately controlled by the authoritative shift-lapse transport-promotion gate.",
  );
  elements.push(intro.svg);
  currentY += intro.height + SECTION_GAP;
  const summaryTiles = [
    {
      label: "Comparison ID",
      value: payload.comparisonId,
      note: "Stable identifier for the unit-lapse baseline vs mild generalized comparison.",
      badgeIds: ["lane_a_unchanged"],
    },
    {
      label: "Scenario ID",
      value: payload.scenarioId,
      note: "Published mild cabin-gravity reference scenario for the generalized branch.",
      badgeIds: ["reference_only"],
    },
    {
      label: "Proof Hierarchy",
      value: "Lane A authoritative | candidate family | transport gate-controlled",
      note: "The overview card remains presentation/comparison only and does not alter proof status; it separates family identity from bounded transport admission, which is controlled separately by the authoritative gate.",
      badgeIds: ["lane_a_unchanged", "reference_only"],
    },
    {
      label: "Provenance Warnings",
      value: `${payload.provenanceWarnings.length}`,
      note: "Rows with mixed-source comparison remain explicitly disclosed rather than normalized away.",
      badgeIds: ["source_mismatch"],
    },
    {
      label: "Wall Safety Source Parity",
      value: payload.comparisonSemantics.wallSafetySourceParity
        ? "brick-derived aligned"
        : "mixed sources",
      note: "Wall safety stays brick-derived in both compared cases.",
      badgeIds: ["wall_safety_brick_derived", "raw_brick"],
    },
    {
      label: "Cabin Gravity Source Policy",
      value: payload.comparisonSemantics.cabinGravityUsesAnalyticCompanion
        ? "analytic companion in mild reference"
        : "raw brick only",
      note: "Mild-reference lapse diagnostics remain precision-aware rather than pretending float32 direct fidelity.",
      badgeIds: ["analytic_companion", "mixed_source"],
    },
    {
      label: "Source/Mechanism Route",
      value: payload.sourceMechanismExemptionRouteActivated
        ? "bounded advisory claims only"
        : "no advisory route active",
      note: "Only source annotation, mechanism context, and reduced-order comparison claims are active; the source/mechanism lane remains non-authoritative.",
      badgeIds: ["lane_a_unchanged", "reference_only"],
    },
    {
      label: "Forbidden Promotions",
      value: "no formula eq | no viability | no cross-lane",
      note: "Parity route remains blocked by derivation-class difference, and this dashboard does not claim gate-passed proof-bearing transport publication for nhm2_shift_lapse.",
      badgeIds: ["lane_a_unchanged", "reference_only"],
    },
  ];
  const tileGap = 16;
  const tileWidth = Math.floor((innerWidth - tileGap) / 2);
  for (let index = 0; index < summaryTiles.length; index += 2) {
    const leftTile = renderSummaryTile(
      summaryTiles[index].label,
      summaryTiles[index].value,
      summaryTiles[index].note,
      summaryTiles[index].badgeIds,
      CARD_MARGIN,
      currentY,
      tileWidth,
    );
    elements.push(leftTile.svg);
    let rowHeight = leftTile.height;
    const rightTileSpec = summaryTiles[index + 1];
    if (rightTileSpec) {
      const rightTile = renderSummaryTile(
        rightTileSpec.label,
        rightTileSpec.value,
        rightTileSpec.note,
        rightTileSpec.badgeIds,
        CARD_MARGIN + tileWidth + tileGap,
        currentY,
        tileWidth,
      );
      elements.push(rightTile.svg);
      rowHeight = Math.max(rowHeight, rightTile.height);
    }
    currentY += rowHeight + SECTION_GAP;
  }
  const companions = renderCompanionCardList(CARD_SPECS, CARD_MARGIN, currentY, innerWidth);
  elements.push(companions.svg);
  currentY += companions.height + CARD_MARGIN;
  const totalHeight = Math.max(spec.minHeight, currentY);
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${totalHeight}" viewBox="0 0 ${width} ${totalHeight}">
  <rect width="${width}" height="${totalHeight}" fill="#f1ece3" />
  ${header.svg}
  ${elements.join("")}
</svg>`.trim();
};

const renderPanelCard = (
  payload: DashboardSeed,
  spec: CardSpec,
  panel: DashboardPanel,
  options: { includeWarnings?: boolean; includeLegend?: boolean } = {},
) => {
  const width = spec.width;
  const innerWidth = width - CARD_MARGIN * 2;
  const headerBadges =
    spec.cardId === "proof_status"
      ? ["lane_a_unchanged", "reference_only"]
      : spec.cardId === "wall_safety"
        ? ["wall_safety_brick_derived"]
        : spec.cardId === "precision_provenance"
          ? ["mixed_source", "source_mismatch", "unresolved"]
          : ["mixed_source", "analytic_companion"];
  const subtitleByCard: Record<DashboardCardId, string> = {
    dashboard_overview: "",
    proof_status:
      "Lane A authoritative | candidate solve family | transport gate-controlled",
    cabin_gravity:
      "Local lapse diagnostics | mild reference may use analytic companion under float32 under-resolution",
    wall_safety:
      "Brick-derived combined shift/lapse horizon proxy | separate from cabin gravity diagnostics",
    precision_provenance:
      "Mixed-source comparison disclosure | parity blocked and formula-equivalence not implied",
  };
  const metaByCard: Record<DashboardCardId, string> = {
    dashboard_overview: "",
    proof_status: `scenario=${payload.scenarioId} | proof=Lane A authoritative | family=${payload.generalizedFamilyAuthorityStatus}`,
    cabin_gravity: `scenario=${payload.scenarioId} | crossCaseSourceMismatchCount=${payload.comparisonSemantics.crossCaseSourceMismatchCount}`,
    wall_safety: `scenario=${payload.scenarioId} | wallSafetySourceParity=${payload.comparisonSemantics.wallSafetySourceParity ? "true" : "false"}`,
    precision_provenance: `scenario=${payload.scenarioId} | provenanceWarnings=${payload.provenanceWarnings.length} | parity=${payload.sourceMechanismParityRouteStatus}`,
  };
  const header = renderCardHeader(
    width,
    `NHM2 Shift+Lapse ${spec.title}`,
    subtitleByCard[spec.cardId],
    metaByCard[spec.cardId],
    headerBadges,
  );
  let currentY = header.bodyY;
  const elements: string[] = [];
  const intro = renderIntroBox(
    CARD_MARGIN,
    currentY,
    innerWidth,
    panel.title,
    panel.purpose,
    panel.sectionNote,
  );
  elements.push(intro.svg);
  currentY += intro.height + SECTION_GAP;
  for (const row of panel.rows) {
    const renderedRow = renderMetricRow(row, CARD_MARGIN, currentY, innerWidth);
    elements.push(renderedRow.svg);
    currentY += renderedRow.height + SECTION_GAP;
  }
  if (options.includeWarnings) {
    const warnings = renderWarningList(
      payload.provenanceWarnings,
      CARD_MARGIN,
      currentY,
      innerWidth,
    );
    elements.push(warnings.svg);
    currentY += warnings.height + SECTION_GAP;
  }
  if (options.includeLegend) {
    const legend = renderBadgeLegendBlock(
      payload.badgeLegend,
      CARD_MARGIN,
      currentY,
      innerWidth,
    );
    elements.push(legend.svg);
    currentY += legend.height + CARD_MARGIN;
  } else {
    currentY += CARD_MARGIN;
  }
  const totalHeight = Math.max(spec.minHeight, currentY);
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${totalHeight}" viewBox="0 0 ${width} ${totalHeight}">
  <rect width="${width}" height="${totalHeight}" fill="#f1ece3" />
  ${header.svg}
  ${elements.join("")}
</svg>`.trim();
};

const svgToInspectionText = (svg: string) =>
  svg.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const buildLinearTicks = (min: number, max: number, count: number) => {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0];
  if (Math.abs(max - min) < 1e-30) return [min];
  const step = (max - min) / Math.max(1, count - 1);
  return Array.from({ length: count }, (_, index) => min + step * index);
};

const formatGraphTickValue = (value: number) => {
  const abs = Math.abs(value);
  if (abs === 0) return "0";
  if (abs >= 1e4 || abs < 1e-3) return value.toExponential(2).replace(/e\+?/, "e");
  if (abs >= 100) return value.toFixed(1);
  if (abs >= 1) return value.toFixed(3).replace(/\.?0+$/, "");
  return value.toFixed(6).replace(/\.?0+$/, "");
};

const renderGraphSvg = (block: DashboardGraphSeriesBlock, spec: GraphSpec) => {
  const width = spec.width;
  const outerPadding = 56;
  const title = renderTextLines([spec.title], outerPadding, 58, TEXT.sectionTitle);
  const subtitle = renderTextLines(
    [
      `${block.quantitySymbol} | ${block.quantityUnits} | comparison_panel | presentation only`,
      "Lane A authoritative | candidate family | transport reference_only cross-lane | transport_context absent",
    ],
    outerPadding,
    92,
    TEXT.headerMeta,
  );
  const baselineBadgeTitle = renderTextLines(
    ["Baseline source"],
    outerPadding,
    146,
    TEXT.blockCaption,
  );
  const baselineBadges = renderBadgeStrip(
    block.baselineBadgeIds,
    outerPadding,
    156,
    260,
  );
  const generalizedBadgeTitle = renderTextLines(
    ["Generalized source"],
    outerPadding + 290,
    146,
    TEXT.blockCaption,
  );
  const generalizedBadges = renderBadgeStrip(
    block.generalizedBadgeIds,
    outerPadding + 290,
    156,
    280,
  );
  const sharedBadgeTitle = renderTextLines(
    ["Comparison badges"],
    outerPadding + 600,
    146,
    TEXT.blockCaption,
  );
  const sharedBadges = renderBadgeStrip(
    block.sharedBadgeIds,
    outerPadding + 600,
    156,
    280,
  );
  const badgeBandHeight = Math.max(
    baselineBadges.height,
    generalizedBadges.height,
    sharedBadges.height,
  );
  const plotLeft = 132;
  const plotTop = 236 + badgeBandHeight;
  const plotWidth = width - plotLeft - 72;
  const plotHeight = 350;
  const plotBottom = plotTop + plotHeight;
  const plotRight = plotLeft + plotWidth;
  const xDomainMin = block.sampleDomain[0] ?? -1;
  const xDomainMax = block.sampleDomain[block.sampleDomain.length - 1] ?? 1;
  const allValues = [...block.baselineSeries, ...block.generalizedSeries].filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
  let yMin = allValues.length > 0 ? Math.min(...allValues) : 0;
  let yMax = allValues.length > 0 ? Math.max(...allValues) : 1;
  if (Math.abs(yMax - yMin) < 1e-30) {
    const pad = Math.max(1e-12, Math.abs(yMax || 1) * 0.2);
    yMin -= pad;
    yMax += pad;
  } else {
    const pad = Math.max(1e-18, (yMax - yMin) * 0.12);
    yMin -= pad;
    yMax += pad;
  }
  if (block.graphId === "cabin_gravity_profile_z") {
    yMin = Math.min(0, yMin);
  }
  const xFor = (value: number) =>
    plotLeft +
    ((value - xDomainMin) / Math.max(1e-30, xDomainMax - xDomainMin)) * plotWidth;
  const yFor = (value: number) =>
    plotBottom -
    ((value - yMin) / Math.max(1e-30, yMax - yMin)) * plotHeight;
  const buildPolyline = (series: Array<number | null>) =>
    series
      .map((value, index) =>
        value == null
          ? null
          : `${xFor(block.sampleDomain[index] ?? xDomainMin)},${yFor(value)}`,
      )
      .filter((value): value is string => Boolean(value))
      .join(" ");
  const buildMarkers = (series: Array<number | null>, fill: string) =>
    series
      .map((value, index) =>
        value == null
          ? ""
          : `<circle cx="${xFor(block.sampleDomain[index] ?? xDomainMin)}" cy="${yFor(value)}" r="4.5" fill="${fill}" stroke="#ffffff" stroke-width="1.5" />`,
      )
      .join("");
  const yTicks = buildLinearTicks(yMin, yMax, 5);
  const xTicks = buildLinearTicks(xDomainMin, xDomainMax, 5);
  const grid = [
    ...yTicks.map((tick) => {
      const y = yFor(tick);
      return [
        `<line x1="${plotLeft}" y1="${y}" x2="${plotRight}" y2="${y}" stroke="#d4d9df" stroke-width="1" stroke-dasharray="4 8" />`,
        `<text x="${plotLeft - 18}" y="${y + 5}" fill="#5a6270" font-size="12" font-weight="600" font-family="${FONT_FAMILY}" text-anchor="end">${escapeXml(
          formatGraphTickValue(tick),
        )}</text>`,
      ].join("");
    }),
    ...xTicks.map((tick) => {
      const x = xFor(tick);
      return [
        `<line x1="${x}" y1="${plotTop}" x2="${x}" y2="${plotBottom}" stroke="#e1e6eb" stroke-width="1" stroke-dasharray="4 8" />`,
        `<text x="${x}" y="${plotBottom + 28}" fill="#5a6270" font-size="12" font-weight="600" font-family="${FONT_FAMILY}" text-anchor="middle">${escapeXml(
          formatGraphTickValue(tick),
        )}</text>`,
      ].join("");
    }),
  ].join("");
  const zeroLine =
    yMin <= 0 && yMax >= 0
      ? `<line x1="${plotLeft}" y1="${yFor(0)}" x2="${plotRight}" y2="${yFor(0)}" stroke="#7d8690" stroke-width="1.5" />`
      : "";
  const legendY = plotTop - 30;
  const legend = [
    `<line x1="${plotLeft}" y1="${legendY}" x2="${plotLeft + 36}" y2="${legendY}" stroke="#536170" stroke-width="4" stroke-dasharray="10 8" stroke-linecap="round" />`,
    `<text x="${plotLeft + 48}" y="${legendY + 5}" fill="#334150" font-size="14" font-weight="700" font-family="${FONT_FAMILY}">Baseline unit-lapse NHM2</text>`,
    `<line x1="${plotLeft + 290}" y1="${legendY}" x2="${plotLeft + 326}" y2="${legendY}" stroke="#a14a2a" stroke-width="4" stroke-linecap="round" />`,
    `<text x="${plotLeft + 338}" y="${legendY + 5}" fill="#334150" font-size="14" font-weight="700" font-family="${FONT_FAMILY}">Generalized mild shift-plus-lapse</text>`,
  ].join("");
  const yAxisLabel = `<text x="44" y="${plotTop + plotHeight / 2}" fill="#334150" font-size="14" font-weight="700" font-family="${FONT_FAMILY}" text-anchor="middle" transform="rotate(-90 44 ${plotTop + plotHeight / 2})">${escapeXml(
    `${block.quantitySymbol} (${block.quantityUnits})`,
  )}</text>`;
  const xAxisLabel = `<text x="${plotLeft + plotWidth / 2}" y="${plotBottom + 56}" fill="#334150" font-size="14" font-weight="700" font-family="${FONT_FAMILY}" text-anchor="middle">${escapeXml(
    block.sampleAxisLabel,
  )}</text>`;
  const noteLines = wrapText(block.graphNote, width - outerPadding * 2 - 28, TEXT.note);
  const noteText = renderTextLines(
    noteLines,
    outerPadding + 14,
    plotBottom + 98,
    TEXT.note,
  );
  const noteHeight = Math.max(86, noteText.height + 28);
  const totalHeight = Math.max(spec.minHeight, plotBottom + 98 + noteHeight + 32);
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${totalHeight}" viewBox="0 0 ${width} ${totalHeight}">
  <rect width="${width}" height="${totalHeight}" fill="#f2efe8" />
  ${title.svg}
  ${subtitle.svg}
  ${baselineBadgeTitle.svg}
  ${baselineBadges.svg}
  ${generalizedBadgeTitle.svg}
  ${generalizedBadges.svg}
  ${sharedBadgeTitle.svg}
  ${sharedBadges.svg}
  <rect x="${plotLeft}" y="${plotTop}" width="${plotWidth}" height="${plotHeight}" rx="18" fill="#fbfaf7" stroke="#bec7cf" stroke-width="1.5" />
  ${grid}
  ${zeroLine}
  ${legend}
  <polyline fill="none" stroke="#536170" stroke-width="4" stroke-dasharray="10 8" stroke-linejoin="round" stroke-linecap="round" points="${buildPolyline(
    block.baselineSeries,
  )}" />
  <polyline fill="none" stroke="#a14a2a" stroke-width="4" stroke-linejoin="round" stroke-linecap="round" points="${buildPolyline(
    block.generalizedSeries,
  )}" />
  ${buildMarkers(block.baselineSeries, "#536170")}
  ${buildMarkers(block.generalizedSeries, "#a14a2a")}
  ${yAxisLabel}
  ${xAxisLabel}
  <rect x="${outerPadding}" y="${plotBottom + 70}" width="${width - outerPadding * 2}" height="${noteHeight}" rx="18" fill="#fbfaf7" stroke="#d0d6dd" stroke-width="1.5" />
  ${noteText.svg}
</svg>`.trim();
};

const buildDashboardCardRenderSources = (
  payload: DashboardSeed,
): DashboardRenderedCardSource[] =>
  CARD_SPECS.map((spec) => {
    const svg =
      spec.cardId === "dashboard_overview"
        ? renderOverviewCard(payload, spec)
        : renderPanelCard(
            payload,
            spec,
            panelById(payload, spec.sectionSource as DashboardPanelId),
            {
              includeWarnings: spec.cardId === "precision_provenance",
              includeLegend: spec.cardId === "precision_provenance",
            },
          );
    return {
      cardId: spec.cardId,
      title: spec.title,
      sectionSource: spec.sectionSource,
      primary: spec.primary,
      svg,
      inspectionText: svgToInspectionText(svg),
    };
  });

const buildDashboardGraphRenderSources = (
  payload: DashboardSeed,
): DashboardRenderedGraphSource[] =>
  payload.graphSeriesBlocks.map((block) => {
    const spec = graphSpecById(block.graphId);
    const svg = renderGraphSvg(block, spec);
    return {
      graphId: block.graphId,
      title: spec.title,
      sourcePanel: spec.sourcePanel,
      svg,
      inspectionText: svgToInspectionText(svg),
    };
  });

const renderDashboardCardFamily = async (payload: DashboardSeed) => {
  fs.mkdirSync(OUT_RENDER_DIR, { recursive: true });
  if (fs.existsSync(LEGACY_CARD_PATH)) {
    fs.rmSync(LEGACY_CARD_PATH, { force: true });
  }
  const renderedCards: DashboardCardEntry[] = [];
  for (const source of buildDashboardCardRenderSources(payload)) {
    const spec = cardSpecById(source.cardId);
    const png = await sharp(Buffer.from(source.svg, "utf8"))
      .png({ compressionLevel: 9, quality: 100 })
      .toBuffer();
    const absPath = buildCardAbsolutePath(spec.cardId);
    ensureDirForFile(absPath);
    fs.writeFileSync(absPath, png);
    renderedCards.push({
      cardId: spec.cardId,
      title: spec.title,
      path: normalizePath(path.relative(ROOT, absPath)),
      hash: sha256(png),
      renderCategory: "comparison_panel",
      renderRole: "presentation",
      sectionSource: spec.sectionSource,
      layoutVersion: DASHBOARD_LAYOUT_VERSION,
      primary: spec.primary,
    });
  }
  const primaryCard = renderedCards.find((card) => card.primary) ?? null;
  return {
    dashboardSurfaceKind: "diagnostics_dashboard_json_with_rendered_card_and_graph_family",
    dashboardLayoutVersion: DASHBOARD_LAYOUT_VERSION,
    renderedCardFamilyStatus: "generated",
    renderedCardReadingOrder: CARD_SPECS.map((spec) => spec.cardId),
    primaryRenderedCardId: primaryCard?.cardId ?? null,
    renderedCards,
    legacyMonolithicCardStatus: "deprecated_not_generated",
    legacyMonolithicCardPath: normalizePath(path.relative(ROOT, LEGACY_CARD_PATH)),
    renderedCardStatus: primaryCard ? "generated_primary_overview" : "missing_primary_card",
    renderedCardPath: primaryCard?.path ?? null,
    renderedCardHash: primaryCard?.hash ?? null,
    renderedCardCategory: primaryCard?.renderCategory ?? null,
    renderedCardRole: primaryCard?.renderRole ?? null,
    renderedCardLayoutVersion: primaryCard?.layoutVersion ?? null,
  };
};

const renderDashboardGraphFamily = async (payload: DashboardSeed) => {
  fs.mkdirSync(OUT_RENDER_DIR, { recursive: true });
  const graphRenders: DashboardGraphRenderEntry[] = [];
  for (const source of buildDashboardGraphRenderSources(payload)) {
    const spec = graphSpecById(source.graphId);
    const png = await sharp(Buffer.from(source.svg, "utf8"))
      .png({ compressionLevel: 9, quality: 100 })
      .toBuffer();
    const absPath = buildGraphAbsolutePath(spec.graphId);
    ensureDirForFile(absPath);
    fs.writeFileSync(absPath, png);
    graphRenders.push({
      graphId: spec.graphId,
      title: spec.title,
      path: normalizePath(path.relative(ROOT, absPath)),
      hash: sha256(png),
      renderCategory: "comparison_panel",
      renderRole: "presentation",
      authoritativeStatus: "non_authoritative",
      sourcePanel: spec.sourcePanel,
      sourceSeriesBlock: spec.graphId,
      layoutVersion: DASHBOARD_LAYOUT_VERSION,
    });
  }
  return {
    graphRenderStatus: graphRenders.length > 0 ? "generated" : "missing",
    graphReadingOrder: GRAPH_SPECS.map((spec) => spec.graphId),
    graphRenders,
  };
};

const computeRenderTaxonomyChecksum = (payload: RenderTaxonomyArtifact) =>
  sha256(JSON.stringify(payload));

const recomputeRenderTaxonomySummary = (renderEntries: RenderTaxonomyEntry[]) => {
  const categoryCounts: Record<string, number> = {
    diagnostic_lane_a: 0,
    transport_context: 0,
    scientific_3p1_field: 0,
    comparison_panel: 0,
    mechanism_overlay: 0,
    invariant_crosscheck: 0,
  };
  for (const entry of renderEntries) {
    categoryCounts[entry.renderCategory] = (categoryCounts[entry.renderCategory] ?? 0) + 1;
  }
  return {
    totalRenderCount: renderEntries.length,
    categoryCounts,
    authoritativeRenderCount: renderEntries.filter(
      (entry) => entry.authoritativeStatus === "primary_authoritative",
    ).length,
    secondaryRenderCount: renderEntries.filter(
      (entry) => entry.authoritativeStatus !== "primary_authoritative",
    ).length,
  };
};

const buildDashboardRenderTaxonomyEntries = (dashboard: DashboardPayload): RenderTaxonomyEntry[] =>
  dashboard.renderedCards.map((card) => {
    const spec = cardSpecById(card.cardId);
    const titleByCard: Record<DashboardCardId, string> = {
      dashboard_overview:
        "Diagnostics Dashboard Overview - Unit-Lapse NHM2 vs Mild Shift+Lapse",
      proof_status: "Proof Status - Unit-Lapse NHM2 vs Mild Shift+Lapse",
      cabin_gravity: "Cabin Gravity - Unit-Lapse NHM2 vs Mild Shift+Lapse",
      wall_safety: "Wall Safety - Unit-Lapse NHM2 vs Mild Shift+Lapse",
      precision_provenance:
        "Precision / Provenance - Unit-Lapse NHM2 vs Mild Shift+Lapse",
    };
    return {
      renderId: `nhm2_shift_lapse:comparison_panel:diagnostics_dashboard:${card.cardId}`,
      caseId: "nhm2_shift_lapse",
      renderCategory: "comparison_panel",
      renderRole: "presentation",
      fieldId: "diagnostics_dashboard",
      variant: spec.variant,
      canonicalPath: card.path,
      legacyPath: null,
      authoritativeStatus: "secondary_interpretive",
      primaryScientificQuestion: spec.question,
      baseImagePolicy: "diagnostic_card_canvas",
      baseImageSource: "none",
      inheritsTransportContext: false,
      contextCompositionMode: "none",
      title: titleByCard[card.cardId],
      subtitle:
        card.cardId === "dashboard_overview"
          ? "overview index | proof=Lane A authoritative | generalized=reference_only | transport_context=absent"
          : `${card.sectionSource} | proof=Lane A authoritative | generalized=reference_only | transport_context=absent`,
      quantitySymbol: "diagnostic dashboard",
      quantityUnits: "n/a",
      observer: "eulerian_n",
      foliation: "comoving_cartesian_3p1",
      signConvention:
        "Dashboard cards preserve baseline raw-brick values, generalized analytic-companion mild-lapse rows where required, and brick-derived wall-safety rows.",
      laneId: `${dashboard.proofPolicy.authoritativeProofSurface ?? "lane_a_eulerian_comoving_theta_minus_trk"}`,
      displayPolicyId: null,
      displayRangeMin: null,
      displayRangeMax: null,
      displayTransform: null,
      colormapFamily: null,
      cameraPoseId: `diagnostics_dashboard_${card.cardId}`,
      orientationConventionId: "x_ship_y_port_z_zenith",
    };
  });

const buildDashboardGraphRenderTaxonomyEntries = (
  dashboard: DashboardPayload,
): RenderTaxonomyEntry[] =>
  dashboard.graphRenders.map((graph) => {
    const spec = graphSpecById(graph.graphId);
    const block = dashboard.graphSeriesBlocks.find(
      (entry) => entry.graphId === graph.graphId,
    )!;
    return {
      renderId: `nhm2_shift_lapse:comparison_panel:${graph.graphId}:graph`,
      caseId: "nhm2_shift_lapse",
      renderCategory: "comparison_panel",
      renderRole: "presentation",
      fieldId: graph.graphId,
      variant: spec.variant,
      canonicalPath: graph.path,
      legacyPath: null,
      authoritativeStatus: "non_authoritative",
      primaryScientificQuestion: spec.question,
      baseImagePolicy: "diagnostic_graph_canvas",
      baseImageSource: "none",
      inheritsTransportContext: false,
      contextCompositionMode: "none",
      title: spec.title,
      subtitle:
        "comparison_panel graph | Lane A authoritative | generalized reference_only | presentation only | transport_context absent",
      quantitySymbol: block.quantitySymbol,
      quantityUnits: block.quantityUnits,
      observer: "eulerian_n",
      foliation: "comoving_cartesian_3p1",
      signConvention: block.graphNote,
      laneId: `${dashboard.proofPolicy.authoritativeProofSurface ?? "lane_a_eulerian_comoving_theta_minus_trk"}`,
      displayPolicyId: null,
      displayRangeMin: null,
      displayRangeMax: null,
      displayTransform: null,
      colormapFamily: null,
      cameraPoseId: `diagnostics_graph_${graph.graphId}`,
      orientationConventionId: "x_ship_y_port_z_zenith",
    };
  });

const updateRenderTaxonomyArtifacts = (dashboard: DashboardPayload) => {
  if (
    dashboard.renderedCardFamilyStatus !== "generated" ||
    dashboard.renderedCards.length === 0 ||
    dashboard.graphRenderStatus !== "generated" ||
    dashboard.graphRenders.length === 0
  ) {
    return null;
  }
  if (!fs.existsSync(OUT_RENDER_TAXONOMY_JSON)) {
    throw new Error(
      `render_taxonomy_missing:${normalizePath(path.relative(ROOT, OUT_RENDER_TAXONOMY_JSON))}`,
    );
  }
  const taxonomy = JSON.parse(
    fs.readFileSync(OUT_RENDER_TAXONOMY_JSON, "utf8"),
  ) as RenderTaxonomyArtifact;
  const renderEntries = [
    ...taxonomy.renderEntries.filter(
      (entry: RenderTaxonomyEntry) =>
        !entry.renderId.startsWith("nhm2_shift_lapse:comparison_panel:"),
    ),
    ...buildDashboardRenderTaxonomyEntries(dashboard),
    ...buildDashboardGraphRenderTaxonomyEntries(dashboard),
  ];
  const graphFieldIds = new Set(DASHBOARD_GRAPH_FIELD_FAMILIES.map((entry) => entry.fieldId));
  const fieldFamilies = [
    ...taxonomy.fieldFamilies.filter(
      (entry: any) =>
        entry.fieldId !== DASHBOARD_FIELD_FAMILY.fieldId &&
        !graphFieldIds.has(entry.fieldId),
    ),
    DASHBOARD_FIELD_FAMILY,
    ...DASHBOARD_GRAPH_FIELD_FAMILIES,
  ].sort((lhs: any, rhs: any) => lhs.label.localeCompare(rhs.label));
  const notes = Array.from(
    new Set([
      ...taxonomy.notes,
      "diagnostics_dashboard comparison_panel outputs now ship as a measured multi-card family on a neutral diagnostic card canvas with inline provenance badges and no transport-context inheritance.",
      "nhm2_shift_lapse comparison_panel graph outputs now ship as provenance-aware diagnostic graphs on a neutral graph canvas with explicit raw-brick versus analytic-companion source badges and no transport-context inheritance.",
    ]),
  );
  const artifactBase = {
    ...taxonomy,
    generatedAt: new Date().toISOString(),
    fieldFamilies,
    renderEntries,
    summary: recomputeRenderTaxonomySummary(renderEntries),
    notes,
  };
  const nextArtifact = {
    ...artifactBase,
    checksum: computeRenderTaxonomyChecksum(artifactBase),
  };
  ensureDirForFile(OUT_RENDER_TAXONOMY_JSON);
  ensureDirForFile(OUT_RENDER_TAXONOMY_AUDIT);
  fs.writeFileSync(
    OUT_RENDER_TAXONOMY_JSON,
    `${JSON.stringify(nextArtifact, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    OUT_RENDER_TAXONOMY_AUDIT,
    renderRenderTaxonomyAuditMarkdown(nextArtifact as any),
    "utf8",
  );
  return {
    outRenderTaxonomyJson: OUT_RENDER_TAXONOMY_JSON,
    outRenderTaxonomyAudit: OUT_RENDER_TAXONOMY_AUDIT,
  };
};

export const buildShiftPlusLapseDashboardPayload = async (
  comparisonPayload?: any,
): Promise<DashboardPayload> => {
  const comparison =
    comparisonPayload ?? (await buildShiftPlusLapseComparisonPayload());
  const sourceMechanism = loadSourceMechanismPolicyContext();
  const proofRows = buildProofRows(comparison);
  const cabinRows = CABIN_ROW_IDS.map((id) =>
    buildDashboardRow(
      findQuantity(comparison.cabinGravityComparison, id),
      "cabin_gravity_panel",
    ),
  );
  const wallRows = WALL_ROW_IDS.map((id) =>
    buildDashboardRow(
      findQuantity(comparison.wallSafetyComparison, id),
      "wall_safety_panel",
    ),
  );
  const precisionRows = buildPrecisionRows(comparison);
  const graphSeriesBlocks = buildDashboardGraphSeriesBlocks(comparison);
  const basePayload: DashboardSeed = {
    artifactId: "nhm2_shift_plus_lapse_dashboard",
    capturedAt: new Date().toISOString(),
    date: DATE_STAMP,
    dashboardId: "nhm2_unit_lapse_vs_mild_shift_plus_lapse_dashboard",
    dashboardStatus: "available",
    comparisonId: comparison.comparisonId,
    scenarioId: comparison.scenarioId,
    proofPolicy: {
      ...comparison.proofPolicy,
      disclaimer: [
        ...(Array.isArray(comparison.proofPolicy?.disclaimer)
          ? comparison.proofPolicy.disclaimer
          : []),
        "Source/mechanism exemption activation is limited to bounded non-authoritative advisory claims only.",
        "No formula-equivalence, viability-promotion, or cross-lane authority-expansion claim is made from this dashboard.",
      ],
      dashboardNote:
        "This dashboard is a human-facing comparison surface only. It does not replace Lane A. nhm2_shift_lapse is shown as a candidate authoritative solve family in full-solve provenance/model-selection while proof-bearing bounded transport admission remains separately controlled by the authoritative shift-lapse transport-promotion gate, and any active source/mechanism route remains bounded to non-authoritative advisory claims.",
    },
    baselineBranchStatus: comparison.baselineBranchStatus,
    generalizedBranchStatus: comparison.generalizedBranchStatus,
    baselineFamilyAuthorityStatus: comparison.baselineFamilyAuthorityStatus,
    generalizedFamilyAuthorityStatus: comparison.generalizedFamilyAuthorityStatus,
    baselineTransportCertificationStatus:
      comparison.baselineTransportCertificationStatus,
    generalizedTransportCertificationStatus:
      comparison.generalizedTransportCertificationStatus,
    sourceMechanismPromotionContractStatus: sourceMechanism.contractStatus,
    sourceMechanismSelectedPromotionRoute: sourceMechanism.selectedPromotionRoute,
    sourceMechanismExemptionRouteActivated: sourceMechanism.exemptionRouteActivated,
    sourceMechanismNonAuthoritative: sourceMechanism.nonAuthoritative,
    sourceMechanismFormulaEquivalent: sourceMechanism.formulaEquivalent,
    sourceMechanismParityRouteStatus: sourceMechanism.parityRouteStatus,
    sourceMechanismParityRouteBlockingClass: sourceMechanism.parityRouteBlockingClass,
    sourceMechanismActiveClaimSet: [...sourceMechanism.activeClaimSet],
    sourceMechanismBlockedClaimSet: [...sourceMechanism.blockedClaimSet],
    sourceMechanismForbiddenPromotions: [...sourceMechanism.forbiddenPromotions],
    sourceMechanismReferenceOnlyScope: sourceMechanism.referenceOnlyScope,
    sourceMechanismConsumerSummary: sourceMechanism.consumerSummary,
    comparisonSemantics: {
      crossCaseSourceMismatchCount:
        comparison.comparisonSummary.crossCaseSourceMismatchCount,
      wallSafetySourceParity: comparison.comparisonSummary.wallSafetySourceParity,
      cabinGravityUsesAnalyticCompanion:
        comparison.comparisonSummary.cabinGravityUsesAnalyticCompanion,
    },
    panels: [
      {
        panelId: "proof_status_panel",
        title: "Proof Status",
        purpose:
          "Keep proof hierarchy explicit before reading any lapse or wall-safety diagnostic row.",
        rows: proofRows,
        sectionNote:
          "Lane A remains authoritative. nhm2_shift_lapse is a candidate authoritative solve family in full-solve provenance/model-selection, while proof-bearing bounded transport admission remains separately controlled by the authoritative shift-lapse transport-promotion gate and is not claimed by this dashboard. Source/mechanism context is bounded non-authoritative advisory only; no formula equivalence, viability promotion, or cross-lane authority expansion is implied.",
      },
      {
        panelId: "cabin_gravity_panel",
        title: "Cabin Gravity",
        purpose:
          "Compare local lapse diagnostics and clock-split observables between the unit-lapse baseline and the mild generalized branch.",
        rows: cabinRows,
        sectionNote:
          "These are local lapse diagnostics. In the mild generalized branch they may use analytic companion reporting under float32 under-resolution.",
      },
      {
        panelId: "wall_safety_panel",
        title: "Wall Safety",
        purpose:
          "Compare combined shift/lapse horizon-proxy diagnostics without treating them as comfort metrics.",
        rows: wallRows,
        sectionNote:
          "Wall safety remains a separate diagnostic family from cabin gravity and stays brick-derived in the current comparison.",
      },
      {
        panelId: "precision_panel",
        title: "Precision / Provenance",
        purpose:
          "Show how raw-brick and analytic-companion provenance are mixed or aligned across the comparison.",
        rows: precisionRows,
        sectionNote:
          "Read these rows before collapsing the dashboard into any downstream summary. They explain where mild-reference under-resolution is handled analytically, where brick alignment is preserved, and why the active source/mechanism route remains bounded advisory only rather than implying formula equivalence or viability promotion.",
      },
    ],
    badgeLegend: BADGES,
    provenanceWarnings: comparison.provenanceWarnings,
    recommendedReadingOrder: [
      "proof_status_panel",
      "cabin_gravity_panel",
      "wall_safety_panel",
      "precision_panel",
    ],
    graphSeriesBlocks,
  };
  const rendered = await renderDashboardCardFamily(basePayload);
  const renderedGraphs = await renderDashboardGraphFamily(basePayload);
  return {
    ...basePayload,
    dashboardSurfaceKind: rendered.dashboardSurfaceKind,
    dashboardLayoutVersion: rendered.dashboardLayoutVersion,
    layoutBudget: LAYOUT_BUDGET,
    renderedCardFamilyStatus: rendered.renderedCardFamilyStatus,
    renderedCardReadingOrder: rendered.renderedCardReadingOrder,
    primaryRenderedCardId: rendered.primaryRenderedCardId,
    renderedCards: rendered.renderedCards,
    legacyMonolithicCardStatus: rendered.legacyMonolithicCardStatus,
    legacyMonolithicCardPath: rendered.legacyMonolithicCardPath,
    renderedCardStatus: rendered.renderedCardStatus,
    renderedCardPath: rendered.renderedCardPath,
    renderedCardHash: rendered.renderedCardHash,
    renderedCardCategory: rendered.renderedCardCategory,
    renderedCardRole: rendered.renderedCardRole,
    renderedCardLayoutVersion: rendered.renderedCardLayoutVersion,
    graphRenderStatus: renderedGraphs.graphRenderStatus,
    graphReadingOrder: renderedGraphs.graphReadingOrder,
    graphRenders: renderedGraphs.graphRenders,
  };
};

const buildPanelTable = (rows: DashboardRow[]) => {
  const header =
    "| row | baseline | generalized | delta | units | baseline source | generalized source | primary badge | mismatch |";
  const separator = "| --- | --- | --- | --- | --- | --- | --- | --- | --- |";
  const body = rows.map((row) => {
    const baseline = Array.isArray(row.baselineValue)
      ? `[${row.baselineValue.map((entry) => formatValue(entry)).join(", ")}]`
      : `${formatValue(row.baselineValue)}`;
    const generalized = Array.isArray(row.generalizedValue)
      ? `[${row.generalizedValue.map((entry) => formatValue(entry)).join(", ")}]`
      : `${formatValue(row.generalizedValue)}`;
    const delta = Array.isArray(row.delta)
      ? `[${row.delta.map((entry) => formatValue(entry, true)).join(", ")}]`
      : `${formatValue(row.delta, true)}`;
    return `| ${row.label} | ${baseline} | ${generalized} | ${delta} | ${row.units} | ${row.baselineSourceKind ?? "n/a"} | ${row.generalizedSourceKind ?? "n/a"} | ${row.badgeId} | ${row.crossCaseSourceMismatch ? "yes" : "no"} |`;
  });
  return [header, separator, ...body].join("\n");
};

const buildBadgeLegendMarkdown = (badges: BadgeDefinition[]) => {
  const header = "| badge | label | meaning | priority |";
  const separator = "| --- | --- | --- | --- |";
  const rows = badges
    .slice()
    .sort((a, b) => a.displayPriority - b.displayPriority)
    .map(
      (badge) =>
        `| ${badge.badgeId} | ${badge.label} | ${badge.meaning} | ${badge.displayPriority} |`,
    );
  return [header, separator, ...rows].join("\n");
};

const buildRenderedCardsTable = (cards: DashboardCardEntry[]) => {
  const header = "| cardId | title | sectionSource | primary | path | hash |";
  const separator = "| --- | --- | --- | --- | --- | --- |";
  const rows = cards.map(
    (card) =>
      `| ${card.cardId} | ${card.title} | ${card.sectionSource} | ${card.primary ? "yes" : "no"} | ${card.path} | ${card.hash} |`,
  );
  return [header, separator, ...rows].join("\n");
};

const buildGraphSeriesBlockTable = (blocks: DashboardGraphSeriesBlock[]) => {
  const header =
    "| graphId | quantity | sampleAxis | sampleCount | baseline source | generalized source | underResolutionDetected | graphNote |";
  const separator = "| --- | --- | --- | --- | --- | --- | --- | --- |";
  const rows = blocks.map(
    (block) =>
      `| ${block.graphId} | ${block.quantitySymbol} (${block.quantityUnits}) | ${block.sampleAxis} | ${block.sampleCount} | ${block.baselineSourceKind} | ${block.generalizedSourceKind} | ${block.underResolutionDetected ? "yes" : "no"} | ${block.graphNote} |`,
  );
  return [header, separator, ...rows].join("\n");
};

const buildGraphRendersTable = (graphs: DashboardGraphRenderEntry[]) => {
  const header =
    "| graphId | sourcePanel | sourceSeriesBlock | authoritativeStatus | path | hash |";
  const separator = "| --- | --- | --- | --- | --- | --- |";
  const rows = graphs.map(
    (graph) =>
      `| ${graph.graphId} | ${graph.sourcePanel} | ${graph.sourceSeriesBlock} | ${graph.authoritativeStatus} | ${graph.path} | ${graph.hash} |`,
  );
  return [header, separator, ...rows].join("\n");
};

const computeSourceMechanismConsumerConformanceChecksum = (
  payload: SourceMechanismConsumerConformanceArtifact,
) => {
  const copy = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
  delete copy.generatedAt;
  delete copy.checksum;
  return sha256(JSON.stringify(copy));
};

const evaluateSurface = (args: {
  surfaceId: string;
  surfaceType: string;
  inspectionMode: "direct_content" | "pre_raster_render_source";
  dataMode: "artifact_coupled" | "current_build_graph";
  checkedTargets?: string[];
  checks: Array<{ field: string; pass: boolean; note: string }>;
  laneAAuthorityChecks?: string[];
  referenceOnlyChecks?: string[];
  leakedInferences?: string[];
}) => {
  const missingDisclaimers = args.checks
    .filter((entry) => !entry.pass)
    .map((entry) => entry.field);
  const verifiedFields = args.checks
    .filter((entry) => entry.pass)
    .map((entry) => entry.field);
  const laneAAuthorityChecks = [...(args.laneAAuthorityChecks ?? [])];
  const referenceOnlyChecks = [...(args.referenceOnlyChecks ?? [])];
  return {
    surfaceId: args.surfaceId,
    surfaceType: args.surfaceType,
    inspectionMode: args.inspectionMode,
    dataMode: args.dataMode,
    status: missingDisclaimers.length === 0 && (args.leakedInferences?.length ?? 0) === 0
      ? "conformant"
      : "non_conformant",
    checkedTargets: [...(args.checkedTargets ?? [])],
    checkedFields: args.checks.map((entry) => entry.field),
    verifiedFields,
    missingDisclaimers,
    leakedInferences: [...(args.leakedInferences ?? [])],
    laneAAuthorityChecks,
    laneAAuthorityPresent:
      laneAAuthorityChecks.length > 0 &&
      laneAAuthorityChecks.every((field) => verifiedFields.includes(field)),
    referenceOnlyChecks,
    referenceOnlyPresent:
      referenceOnlyChecks.length > 0 &&
      referenceOnlyChecks.every((field) => verifiedFields.includes(field)),
    notes: args.checks.map((entry) => entry.note),
  } satisfies SourceMechanismConsumerSurfaceCheck;
};

export const buildSourceMechanismConsumerConformanceSummary = (args: {
  dashboard: DashboardPayload;
  proofPackArtifact: any;
  proofPackMarkdown: string;
  dashboardAuditMarkdown: string;
}): Omit<SourceMechanismConsumerConformanceSummary, "artifactPath" | "reportPath"> => {
  const requiredDisclaimers = [
    "Only the three bounded advisory source/mechanism claims are active.",
    "The source/mechanism lane remains non-authoritative.",
    "The direct-proxy parity route remains blocked by derivation-class difference.",
    "Formula equivalence to the authoritative direct metric remains false/blocked.",
    "Viability promotion from the source/mechanism lane remains blocked.",
    "Cross-lane expansion beyond reference_only remains blocked.",
    "warp.metric.T00.nhm2_shift_lapse is a candidate authoritative solve family in provenance/model-selection while proof-bearing bounded transport admission remains separately controlled by the authoritative shift-lapse transport-promotion gate and is not claimed by this dashboard.",
  ];
  const proofPanel = panelById(args.dashboard, "proof_status_panel");
  const authoritativeProofSurfaceRow =
    proofPanel.rows.find((row) => row.rowId === "authoritative_proof_surface") ?? null;
  const familyStatusRow =
    proofPanel.rows.find((row) => row.rowId === "generalized_family_status") ?? null;
  const transportStatusRow =
    proofPanel.rows.find((row) => row.rowId === "generalized_transport_status") ?? null;
  const proofPackSummary = args.proofPackArtifact.sourceMechanismPromotionContract ?? {};
  const proofPackSurface = evaluateSurface({
    surfaceId: "proof_pack_alias_json",
    surfaceType: "json_alias",
    inspectionMode: "direct_content",
    dataMode: "artifact_coupled",
    checkedTargets: [
      "sourceMechanismPromotionContract",
      "sourceMechanismMaturity",
      "sourceFormulaAudit",
      "sourceMechanismParityRouteFeasibility",
    ],
    checks: [
      {
        field: "activeClaimSet",
        pass:
          Array.isArray(proofPackSummary.sourceMechanismActiveClaimSet) &&
          proofPackSummary.sourceMechanismActiveClaimSet.length === 3,
        note: "Proof-pack alias must carry the active bounded claim set.",
      },
      {
        field: "blockedClaimSet",
        pass:
          Array.isArray(proofPackSummary.sourceMechanismBlockedClaimSet) &&
          proofPackSummary.sourceMechanismBlockedClaimSet.includes(
            "formula_equivalent_to_authoritative_direct_metric",
          ) &&
          proofPackSummary.sourceMechanismBlockedClaimSet.includes(
            "source_mechanism_layer_supports_viability_promotion",
          ) &&
          proofPackSummary.sourceMechanismBlockedClaimSet.includes(
            "cross_lane_promotion_beyond_reference_only_scope",
          ),
        note: "Proof-pack alias must keep stronger source/mechanism claims blocked.",
      },
      {
        field: "forbiddenPromotions",
        pass:
          Array.isArray(proofPackSummary.sourceMechanismForbiddenPromotions) &&
          proofPackSummary.sourceMechanismForbiddenPromotions.includes(
            "nhm2_shift_lapse_proof_promotion",
          ),
        note: "Proof-pack alias must explicitly forbid nhm2_shift_lapse proof promotion.",
      },
      {
        field: "referenceOnlyScope",
        pass: proofPackSummary.sourceMechanismReferenceOnlyScope === true,
        note: "Proof-pack alias must preserve reference_only cross-lane scope.",
      },
      {
        field: "laneAAuthoritativeField",
        pass: args.proofPackArtifact.sourceMechanismMaturity?.laneAAuthoritative === true,
        note: "Proof-pack JSON must expose an explicit Lane A authoritative field.",
      },
      {
        field: "activationSummaryLaneA",
        pass:
          typeof proofPackSummary.activationSummary === "string" &&
          proofPackSummary.activationSummary.includes("Lane A remains authoritative"),
        note: "Proof-pack JSON must state that the active bounded route leaves Lane A authoritative.",
      },
      {
        field: "consumerSummary",
        pass:
          typeof proofPackSummary.sourceMechanismConsumerSummary === "string" &&
          proofPackSummary.sourceMechanismConsumerSummary.includes(
            "candidate authoritative solve family",
          ),
        note: "Proof-pack alias must summarize the bounded advisory boundary explicitly.",
      },
      {
        field: "formulaEquivalent",
        pass: args.proofPackArtifact.sourceFormulaAudit?.formulaEquivalent === false,
        note: "Proof-pack alias must keep formula equivalence false/blocked.",
      },
      {
        field: "parityRouteBlocked",
        pass:
          args.proofPackArtifact.sourceMechanismParityRouteFeasibility
            ?.routeFeasibilityStatus === "blocked_by_derivation_class_difference",
        note: "Proof-pack alias must keep the parity route visibly blocked.",
      },
    ],
    laneAAuthorityChecks: ["laneAAuthoritativeField", "activationSummaryLaneA"],
    referenceOnlyChecks: ["referenceOnlyScope", "consumerSummary"],
  });
  const proofPackMarkdownSurface = evaluateSurface({
    surfaceId: "proof_pack_audit_markdown",
    surfaceType: "markdown_audit",
    inspectionMode: "direct_content",
    dataMode: "artifact_coupled",
    checkedTargets: [
      "Source / Mechanism Maturity",
      "Source / Mechanism Promotion Contract",
    ],
    checks: [
      {
        field: "active_for_bounded_claims_only",
        pass: args.proofPackMarkdown.includes("| contractStatus | active_for_bounded_claims_only |"),
        note: "Proof-pack markdown must show the bounded-only activation status.",
      },
      {
        field: "activeClaimSet",
        pass: args.proofPackMarkdown.includes("| sourceMechanismActiveClaimSet |"),
        note: "Proof-pack markdown must list the active bounded claim set.",
      },
      {
        field: "forbiddenPromotions",
        pass: args.proofPackMarkdown.includes("| sourceMechanismForbiddenPromotions |"),
        note: "Proof-pack markdown must list forbidden promotions explicitly.",
      },
      {
        field: "formulaEquivalentFalse",
        pass: args.proofPackMarkdown.includes("| sourceMechanismFormulaEquivalent | false |"),
        note: "Proof-pack markdown must keep formula equivalence visibly false.",
      },
      {
        field: "referenceOnlyScope",
        pass: args.proofPackMarkdown.includes("| sourceMechanismReferenceOnlyScope | true |"),
        note: "Proof-pack markdown must preserve reference_only cross-lane scope.",
      },
      {
        field: "laneAAuthoritativeField",
        pass: args.proofPackMarkdown.includes("| laneAAuthoritative | true |"),
        note: "Proof-pack markdown must expose the explicit Lane A authoritative field.",
      },
      {
        field: "activationSummaryLaneA",
        pass: args.proofPackMarkdown.includes("Lane A remains authoritative"),
        note: "Proof-pack markdown must state that the active bounded route leaves Lane A authoritative.",
      },
    ],
    laneAAuthorityChecks: ["laneAAuthoritativeField", "activationSummaryLaneA"],
    referenceOnlyChecks: ["referenceOnlyScope"],
  });
  const dashboardProofNote = panelById(args.dashboard, "proof_status_panel").sectionNote;
  const dashboardPrecisionNote = panelById(args.dashboard, "precision_panel").sectionNote;
  const dashboardJsonSurface = evaluateSurface({
    surfaceId: "shift_plus_lapse_dashboard_json",
    surfaceType: "dashboard_json",
    inspectionMode: "direct_content",
    dataMode: "artifact_coupled",
    checkedTargets: [
      "proof_status_panel",
      "precision_panel",
      "sourceMechanism* top-level fields",
    ],
    checks: [
      {
        field: "activeClaimSet",
        pass: args.dashboard.sourceMechanismActiveClaimSet.length === 3,
        note: "Dashboard JSON must carry the active bounded claim set.",
      },
      {
        field: "blockedClaimSet",
        pass:
          args.dashboard.sourceMechanismBlockedClaimSet.includes(
            "source_mechanism_layer_supports_viability_promotion",
          ) &&
          args.dashboard.sourceMechanismBlockedClaimSet.includes(
            "cross_lane_promotion_beyond_reference_only_scope",
          ),
        note: "Dashboard JSON must keep stronger claims blocked.",
      },
      {
        field: "forbiddenPromotions",
        pass: args.dashboard.sourceMechanismForbiddenPromotions.includes(
          "nhm2_shift_lapse_proof_promotion",
        ),
        note: "Dashboard JSON must explicitly forbid nhm2_shift_lapse proof promotion.",
      },
      {
        field: "referenceOnlyScope",
        pass: args.dashboard.sourceMechanismReferenceOnlyScope === true,
        note: "Dashboard JSON must preserve reference_only cross-lane scope.",
      },
      {
        field: "generalizedFamilyAuthorityStatus",
        pass:
          `${familyStatusRow?.generalizedValue ?? ""}` ===
            "candidate_authoritative_solve_family" &&
          args.dashboard.generalizedFamilyAuthorityStatus ===
            "candidate_authoritative_solve_family",
        note: "Dashboard JSON must expose nhm2_shift_lapse as a candidate authoritative solve family.",
      },
      {
        field: "generalizedTransportCertificationStatus",
        pass:
          `${transportStatusRow?.generalizedValue ?? ""}` ===
            "bounded_transport_fail_closed_reference_only" &&
          args.dashboard.generalizedTransportCertificationStatus ===
            "bounded_transport_fail_closed_reference_only",
        note: "Dashboard JSON must keep the default generalized transport certification status fail-closed/reference_only unless a separately selected solve passes the authoritative transport-promotion gate.",
      },
      {
        field: "formulaEquivalentFalse",
        pass: args.dashboard.sourceMechanismFormulaEquivalent === false,
        note: "Dashboard JSON must not imply formula equivalence.",
      },
      {
        field: "parityRouteBlocked",
        pass:
          args.dashboard.sourceMechanismParityRouteStatus ===
          "blocked_by_derivation_class_difference",
        note: "Dashboard JSON must keep the parity route visibly blocked.",
      },
      {
        field: "proofStatusBoundary",
        pass:
          dashboardProofNote.includes("bounded non-authoritative advisory only") &&
          dashboardProofNote.includes("no formula equivalence") &&
          dashboardProofNote.includes("transport-promotion gate"),
        note: "Proof-status panel note must carry the bounded-route boundary.",
      },
      {
        field: "precisionBoundary",
        pass:
          dashboardPrecisionNote.includes("bounded advisory only") &&
          dashboardPrecisionNote.includes("viability promotion"),
        note: "Precision panel note must carry the bounded-route and forbidden-inference boundary.",
      },
      {
        field: "proofStatusSectionNoteLaneA",
        pass: dashboardProofNote.includes("Lane A remains authoritative"),
        note: "Dashboard JSON proof-status note must explicitly preserve Lane A authority.",
      },
      {
        field: "authoritativeProofSurfaceRow",
        pass:
          `${authoritativeProofSurfaceRow?.generalizedValue ?? ""}` ===
          "lane_a_eulerian_comoving_theta_minus_trk",
        note: "Dashboard JSON must keep the authoritative proof-surface row pointed at Lane A.",
      },
    ],
    laneAAuthorityChecks: ["proofStatusSectionNoteLaneA", "authoritativeProofSurfaceRow"],
    referenceOnlyChecks: [
      "referenceOnlyScope",
      "generalizedTransportCertificationStatus",
    ],
  });
  const dashboardMarkdownSurface = evaluateSurface({
    surfaceId: "shift_plus_lapse_dashboard_audit_markdown",
    surfaceType: "markdown_audit",
    inspectionMode: "direct_content",
    dataMode: "artifact_coupled",
    checkedTargets: [
      "Proof Status",
      "Source / Mechanism Consumer Boundary",
      "Source / Mechanism Consumer Conformance",
    ],
    checks: [
      {
        field: "consumerBoundarySection",
        pass: args.dashboardAuditMarkdown.includes("## Source / Mechanism Consumer Boundary"),
        note: "Dashboard audit markdown must include an explicit source/mechanism boundary section.",
      },
      {
        field: "activeClaimSet",
        pass: args.dashboardAuditMarkdown.includes("- activeClaimSet:"),
        note: "Dashboard audit markdown must list the active bounded claim set.",
      },
      {
        field: "forbiddenPromotions",
        pass: args.dashboardAuditMarkdown.includes("- forbiddenPromotions:"),
        note: "Dashboard audit markdown must list forbidden promotions.",
      },
      {
        field: "consumerConformanceSection",
        pass: args.dashboardAuditMarkdown.includes("## Source / Mechanism Consumer Conformance"),
        note: "Dashboard audit markdown must include the conformance result.",
      },
      {
        field: "referenceOnlySummary",
        pass:
          args.dashboardAuditMarkdown.includes(
            "- generalizedFamilyAuthorityStatus: candidate_authoritative_solve_family",
          ) &&
          args.dashboardAuditMarkdown.includes(
            "- generalizedTransportCertificationStatus: bounded_transport_fail_closed_reference_only",
          ),
        note: "Dashboard audit markdown must preserve the family-vs-transport split explicitly.",
      },
      {
        field: "proofNoteLaneA",
        pass: args.dashboardAuditMarkdown.includes("- proofNote: Lane A remains authoritative."),
        note: "Dashboard audit markdown must preserve the explicit Lane A proof note.",
      },
      {
        field: "authoritativeProofSurface",
        pass: args.dashboardAuditMarkdown.includes(
          "- authoritativeProofSurface: lane_a_eulerian_comoving_theta_minus_trk",
        ),
        note: "Dashboard audit markdown must preserve the authoritative proof surface identifier.",
      },
    ],
    laneAAuthorityChecks: ["proofNoteLaneA", "authoritativeProofSurface"],
    referenceOnlyChecks: ["referenceOnlySummary"],
  });
  const renderedCardSources = buildDashboardCardRenderSources(args.dashboard);
  const dashboardOverviewCard =
    renderedCardSources.find((card) => card.cardId === "dashboard_overview") ?? null;
  const proofStatusCard =
    renderedCardSources.find((card) => card.cardId === "proof_status") ?? null;
  const precisionCard =
    renderedCardSources.find((card) => card.cardId === "precision_provenance") ?? null;
  const renderedGraphSources = buildDashboardGraphRenderSources(args.dashboard);
  const gravityGraph =
    renderedGraphSources.find((graph) => graph.graphId === "cabin_gravity_profile_z") ??
    null;
  const clockGraph =
    renderedGraphSources.find((graph) => graph.graphId === "clock_gradient_profile_z") ??
    null;
  const renderedCardSurface = evaluateSurface({
    surfaceId: "shift_plus_lapse_dashboard_cards",
    surfaceType: "rendered_card_family",
    inspectionMode: "pre_raster_render_source",
    dataMode: "artifact_coupled",
    checkedTargets: [
      "dashboard_overview",
      "proof_status",
      "precision_provenance",
    ],
    checks: [
      {
        field: "overviewLaneAAuthority",
        pass:
          typeof dashboardOverviewCard?.inspectionText === "string" &&
          dashboardOverviewCard.inspectionText.includes("Lane A authoritative"),
        note: "Rendered overview card must preserve Lane A authority in the proof hierarchy tile.",
      },
      {
        field: "proofStatusLaneAAuthority",
        pass:
          typeof proofStatusCard?.inspectionText === "string" &&
          proofStatusCard.inspectionText.includes("Lane A authoritative"),
        note: "Rendered proof-status card must preserve Lane A authority in its subtitle/meta.",
      },
      {
        field: "overviewReferenceOnly",
        pass:
          typeof dashboardOverviewCard?.inspectionText === "string" &&
          (dashboardOverviewCard.inspectionText.includes("reference_only") ||
            dashboardOverviewCard.inspectionText.includes("reference-only")),
        note: "Rendered overview card must preserve reference_only transport scope.",
      },
      {
        field: "proofStatusReferenceOnly",
        pass:
          typeof proofStatusCard?.inspectionText === "string" &&
          (proofStatusCard?.inspectionText.includes("reference_only") ||
            proofStatusCard?.inspectionText.includes("reference-only")),
        note: "Rendered proof-status card must preserve reference_only transport scope.",
      },
      {
        field: "overviewCandidateFamily",
        pass:
          typeof dashboardOverviewCard?.inspectionText === "string" &&
          dashboardOverviewCard.inspectionText.includes(
            "candidate authoritative solve family",
          ),
        note: "Rendered overview card must preserve the candidate-family distinction.",
      },
      {
        field: "proofStatusCandidateFamily",
        pass:
          typeof proofStatusCard?.inspectionText === "string" &&
          proofStatusCard.inspectionText.includes("candidate solve family"),
        note: "Rendered proof-status card must preserve the candidate-family distinction.",
      },
      {
        field: "overviewNonAuthoritative",
        pass:
          typeof dashboardOverviewCard?.inspectionText === "string" &&
          dashboardOverviewCard.inspectionText.includes("non-authoritative"),
        note: "Rendered overview card must preserve the non-authoritative source/mechanism boundary.",
      },
      {
        field: "overviewForbiddenPromotionSummary",
        pass:
          typeof dashboardOverviewCard?.inspectionText === "string" &&
          dashboardOverviewCard.inspectionText.includes(
            "no formula eq | no viability | no cross-lane",
          ),
        note: "Rendered overview card must state the forbidden promotions compactly.",
      },
      {
        field: "proofStatusForbiddenPromotionBoundary",
        pass:
          typeof proofStatusCard?.inspectionText === "string" &&
          proofStatusCard.inspectionText.includes(
            "no formula equivalence, viability promotion, or cross-lane authority expansion is implied",
          ),
        note: "Rendered proof-status card must keep the forbidden-inference boundary explicit.",
      },
      {
        field: "precisionFormulaEquivalenceBoundary",
        pass:
          typeof precisionCard?.inspectionText === "string" &&
          precisionCard.inspectionText.includes(
            "formula-equivalence not implied",
          ) &&
          precisionCard.inspectionText.includes("parity blocked"),
        note: "Rendered precision/provenance card must keep formula-equivalence and parity boundaries explicit.",
      },
    ],
    laneAAuthorityChecks: ["overviewLaneAAuthority", "proofStatusLaneAAuthority"],
    referenceOnlyChecks: ["overviewReferenceOnly", "proofStatusReferenceOnly"],
  });
  const renderedGraphSurface = evaluateSurface({
    surfaceId: "shift_plus_lapse_dashboard_graphs",
    surfaceType: "rendered_graph_family",
    inspectionMode: "pre_raster_render_source",
    dataMode: "artifact_coupled",
    checkedTargets: ["cabin_gravity_profile_z", "clock_gradient_profile_z"],
    checks: [
      {
        field: "gravityGraphLaneAAuthority",
        pass:
          typeof gravityGraph?.inspectionText === "string" &&
          gravityGraph.inspectionText.includes("Lane A authoritative"),
        note: "Rendered cabin-gravity graph must preserve Lane A authority in its header metadata.",
      },
      {
        field: "clockGraphLaneAAuthority",
        pass:
          typeof clockGraph?.inspectionText === "string" &&
          clockGraph.inspectionText.includes("Lane A authoritative"),
        note: "Rendered clock-gradient graph must preserve Lane A authority in its header metadata.",
      },
      {
        field: "gravityGraphReferenceOnly",
        pass:
          typeof gravityGraph?.inspectionText === "string" &&
          (gravityGraph.inspectionText.includes("reference_only") ||
            gravityGraph.inspectionText.includes("reference-only")),
        note: "Rendered cabin-gravity graph must preserve reference_only transport scope.",
      },
      {
        field: "clockGraphReferenceOnly",
        pass:
          typeof clockGraph?.inspectionText === "string" &&
          (clockGraph.inspectionText.includes("reference_only") ||
            clockGraph.inspectionText.includes("reference-only")),
        note: "Rendered clock-gradient graph must preserve reference_only transport scope.",
      },
      {
        field: "gravityGraphPresentationOnly",
        pass:
          typeof gravityGraph?.inspectionText === "string" &&
          gravityGraph.inspectionText.includes("Presentation-only graph"),
        note: "Rendered cabin-gravity graph must remain presentation-only and non-authoritative.",
      },
      {
        field: "clockGraphLocalOnlyBoundary",
        pass:
          typeof clockGraph?.inspectionText === "string" &&
          clockGraph.inspectionText.includes("not route-time compression"),
        note: "Rendered clock-gradient graph must keep the local-only timing boundary explicit.",
      },
    ],
    laneAAuthorityChecks: ["gravityGraphLaneAAuthority", "clockGraphLaneAAuthority"],
    referenceOnlyChecks: ["gravityGraphReferenceOnly", "clockGraphReferenceOnly"],
  });
  const checkedSurfaces = [
    proofPackSurface,
    proofPackMarkdownSurface,
    dashboardJsonSurface,
    dashboardMarkdownSurface,
    renderedCardSurface,
    renderedGraphSurface,
  ];
  const conformantSurfaces = checkedSurfaces
    .filter((entry) => entry.status === "conformant")
    .map((entry) => entry.surfaceId);
  const nonConformantSurfaces = checkedSurfaces
    .filter((entry) => entry.status === "non_conformant")
    .map((entry) => entry.surfaceId);
  const laneAAuthorityMissingOnSurfaces = checkedSurfaces
    .filter((entry) => !entry.laneAAuthorityPresent)
    .map((entry) => entry.surfaceId);
  const referenceOnlyMissingOnSurfaces = checkedSurfaces
    .filter((entry) => !entry.referenceOnlyPresent)
    .map((entry) => entry.surfaceId);
  const distinctDataModes = [...new Set(checkedSurfaces.map((entry) => entry.dataMode))];
  const conformanceDataMode =
    distinctDataModes.length === 1
      ? distinctDataModes[0]
      : "mixed_current_build_and_artifact_coupled";
  const stalenessRisk =
    checkedSurfaces.some((entry) => entry.dataMode === "artifact_coupled")
      ? "possible_latest_artifact_drift"
      : "none";
  const artifactCouplingNote =
    conformanceDataMode === "artifact_coupled"
      ? "Consumer-conformance is artifact-coupled: proof-pack surfaces are read from latest aliases, and the dashboard current-build outputs embed source/mechanism policy state sourced from latest artifacts."
      : conformanceDataMode === "mixed_current_build_and_artifact_coupled"
        ? "Consumer-conformance mixes current-build dashboard surfaces with artifact-coupled upstream proof-pack policy inputs; latest-alias drift remains possible."
        : "Consumer-conformance is evaluated only from the current in-memory build graph.";
  return {
    consumerConformanceStatus:
      nonConformantSurfaces.length === 0 &&
      laneAAuthorityMissingOnSurfaces.length === 0 &&
      referenceOnlyMissingOnSurfaces.length === 0
        ? "conformant"
        : "non_conformant",
    conformanceDataMode,
    stalenessRisk,
    artifactCouplingNote,
    checkedSurfaces,
    conformantSurfaces,
    nonConformantSurfaces,
    activeClaimSet: [...args.dashboard.sourceMechanismActiveClaimSet],
    blockedClaimSet: [...args.dashboard.sourceMechanismBlockedClaimSet],
    requiredDisclaimers,
    forbiddenInferences: [...args.dashboard.sourceMechanismForbiddenPromotions],
    referenceOnlyScopePreserved: referenceOnlyMissingOnSurfaces.length === 0,
    referenceOnlyMissingOnSurfaces,
    laneAAuthorityPreserved: laneAAuthorityMissingOnSurfaces.length === 0,
    laneAAuthorityMissingOnSurfaces,
    summary:
      nonConformantSurfaces.length === 0 &&
      laneAAuthorityMissingOnSurfaces.length === 0 &&
      referenceOnlyMissingOnSurfaces.length === 0
        ? `Checked proof-pack JSON/markdown, dashboard JSON/markdown, and rendered dashboard card/graph sources preserve the bounded advisory source/mechanism route, explicit Lane A authority, and the candidate-family versus fail-closed transport split. ${artifactCouplingNote}`
        : `Consumer surfaces still leak or omit bounded-route, Lane A, or reference_only markers on: ${[
            ...new Set([
              ...nonConformantSurfaces,
              ...laneAAuthorityMissingOnSurfaces,
              ...referenceOnlyMissingOnSurfaces,
            ]),
          ].join(", ")}.`,
  };
};

const buildSourceMechanismConsumerConformanceMarkdown = (
  payload: SourceMechanismConsumerConformanceArtifact,
) => {
  const summary = payload.sourceMechanismConsumerConformance;
  const surfaceRows = summary.checkedSurfaces.length
    ? summary.checkedSurfaces
        .map(
          (surface) =>
            `| ${surface.surfaceId} | ${surface.surfaceType} | ${surface.inspectionMode} | ${surface.dataMode} | ${surface.checkedTargets.join(",") || "none"} | ${surface.status} | ${surface.checkedFields.join(",") || "none"} | ${surface.verifiedFields.join(",") || "none"} | ${surface.laneAAuthorityPresent} | ${surface.referenceOnlyPresent} | ${surface.missingDisclaimers.join(",") || "none"} | ${surface.leakedInferences.join(",") || "none"} | ${surface.notes.join("; ") || "none"} |`,
        )
        .join("\n")
    : "| none | none | none | none | none | none | none | none | none | none | none | none | none |";
  const bulletList = (values: string[]) =>
    values.length ? values.map((entry) => `- ${entry}`).join("\n") : "- none";
  return [
    "# NHM2 Source / Mechanism Consumer Conformance",
    "",
    `"${payload.boundaryStatement}"`,
    "",
    "## Source Paths",
    `- proofPackArtifact: \`${payload.proofPackArtifact}\``,
    `- proofPackReport: \`${payload.proofPackReport}\``,
    `- promotionContractArtifact: \`${payload.promotionContractArtifact}\``,
    `- maturityArtifact: \`${payload.maturityArtifact}\``,
    `- dashboardArtifact: \`${payload.dashboardArtifact}\``,
    `- dashboardReport: \`${payload.dashboardReport}\``,
    `- renderedCardDirectory: \`${payload.renderedCardDirectory}\``,
    "",
    "## Consumer Conformance",
    "| field | value |",
    "| --- | --- |",
    `| consumerConformanceStatus | ${summary.consumerConformanceStatus} |`,
    `| conformanceDataMode | ${summary.conformanceDataMode} |`,
    `| stalenessRisk | ${summary.stalenessRisk} |`,
    `| artifactCouplingNote | ${summary.artifactCouplingNote} |`,
    `| referenceOnlyScopePreserved | ${summary.referenceOnlyScopePreserved} |`,
    `| referenceOnlyMissingOnSurfaces | ${summary.referenceOnlyMissingOnSurfaces.join(",") || "none"} |`,
    `| laneAAuthorityPreserved | ${summary.laneAAuthorityPreserved} |`,
    `| laneAAuthorityMissingOnSurfaces | ${summary.laneAAuthorityMissingOnSurfaces.join(",") || "none"} |`,
    `| summary | ${summary.summary} |`,
    "",
    "## Checked Surfaces",
    "| surfaceId | surfaceType | inspectionMode | dataMode | checkedTargets | status | checkedFields | verifiedFields | laneAAuthorityPresent | referenceOnlyPresent | missingDisclaimers | leakedInferences | notes |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    surfaceRows,
    "",
    "## Active Claim Set",
    bulletList(summary.activeClaimSet),
    "",
    "## Blocked Claim Set",
    bulletList(summary.blockedClaimSet),
    "",
    "## Required Disclaimers",
    bulletList(summary.requiredDisclaimers),
    "",
    "## Forbidden Inferences",
    bulletList(summary.forbiddenInferences),
    "",
    "## Notes",
    bulletList(payload.notes),
    "",
  ].join("\n");
};

const buildAuditMarkdown = (payload: DashboardPayload) => {
  const proofPanel = panelById(payload, "proof_status_panel");
  const proofFamilyRow =
    proofPanel.rows.find((row) => row.rowId === "generalized_family_status") ?? null;
  const proofTransportRow =
    proofPanel.rows.find((row) => row.rowId === "generalized_transport_status") ?? null;
  const cabinPanel = panelById(payload, "cabin_gravity_panel");
  const wallPanel = panelById(payload, "wall_safety_panel");
  const precisionPanel = panelById(payload, "precision_panel");
  const warningList =
    payload.provenanceWarnings.length > 0
      ? payload.provenanceWarnings
          .map(
            (warning: any) =>
              `- ${warning.quantityId}: ${warning.note} (${warning.baselineSourceKind} vs ${warning.generalizedSourceKind})`,
          )
          .join("\n")
      : "- none";
  return [
    "# NHM2 Shift-Plus-Lapse Dashboard Companion",
    "",
    `- date: ${payload.date}`,
    `- dashboardId: ${payload.dashboardId}`,
    `- comparisonId: ${payload.comparisonId}`,
    `- scenarioId: ${payload.scenarioId}`,
    `- dashboardStatus: ${payload.dashboardStatus}`,
    `- dashboardLayoutVersion: ${payload.dashboardLayoutVersion}`,
    `- renderedCardFamilyStatus: ${payload.renderedCardFamilyStatus}`,
    `- primaryRenderedCardId: ${payload.primaryRenderedCardId ?? "null"}`,
    `- renderedCardStatus: ${payload.renderedCardStatus}`,
    `- renderedCardPath: ${payload.renderedCardPath ?? "null"}`,
    `- renderedCardHash: ${payload.renderedCardHash ?? "null"}`,
    `- graphRenderStatus: ${payload.graphRenderStatus}`,
    `- legacyMonolithicCardStatus: ${payload.legacyMonolithicCardStatus}`,
    `- legacyMonolithicCardPath: ${payload.legacyMonolithicCardPath ?? "null"}`,
    "",
    "## Proof Status",
    "",
    `- authoritativeProofSurface: ${payload.proofPolicy.authoritativeProofSurface}`,
    `- laneAUnchanged: ${payload.proofPolicy.laneAUnchanged ? "yes" : "no"}`,
    `- baselineBranchStatus: ${payload.baselineBranchStatus}`,
    `- generalizedBranchStatus: ${payload.generalizedBranchStatus}`,
    `- generalizedFamilyAuthorityStatus: ${proofFamilyRow?.generalizedValue ?? payload.generalizedFamilyAuthorityStatus}`,
    `- generalizedTransportCertificationStatus: ${proofTransportRow?.generalizedValue ?? payload.generalizedTransportCertificationStatus}`,
    `- proofNote: ${proofPanel.sectionNote}`,
    "",
    "## Source / Mechanism Consumer Boundary",
    "",
    `- promotionContractStatus: ${payload.sourceMechanismPromotionContractStatus}`,
    `- selectedPromotionRoute: ${payload.sourceMechanismSelectedPromotionRoute}`,
    `- exemptionRouteActivated: ${payload.sourceMechanismExemptionRouteActivated ? "yes" : "no"}`,
    `- sourceMechanismNonAuthoritative: ${payload.sourceMechanismNonAuthoritative ? "yes" : "no"}`,
    `- sourceMechanismFormulaEquivalent: ${payload.sourceMechanismFormulaEquivalent ? "yes" : "no"}`,
    `- parityRouteStatus: ${payload.sourceMechanismParityRouteStatus}`,
    `- parityRouteBlockingClass: ${payload.sourceMechanismParityRouteBlockingClass}`,
    `- sourceMechanismReferenceOnlyScope: ${payload.sourceMechanismReferenceOnlyScope ? "yes" : "no"}`,
    `- activeClaimSet: ${payload.sourceMechanismActiveClaimSet.join(", ") || "none"}`,
    `- blockedClaimSet: ${payload.sourceMechanismBlockedClaimSet.join(", ") || "none"}`,
    `- forbiddenPromotions: ${payload.sourceMechanismForbiddenPromotions.join(", ") || "none"}`,
    `- sourceMechanismConsumerSummary: ${payload.sourceMechanismConsumerSummary}`,
    "",
    "## Cabin Gravity Panel",
    "",
    `- panelPurpose: ${cabinPanel.purpose}`,
    `- sectionNote: ${cabinPanel.sectionNote}`,
    "",
    buildPanelTable(cabinPanel.rows),
    "",
    "## Wall Safety Panel",
    "",
    `- panelPurpose: ${wallPanel.purpose}`,
    `- sectionNote: ${wallPanel.sectionNote}`,
    "",
    buildPanelTable(wallPanel.rows),
    "",
    "## Precision Panel",
    "",
    `- panelPurpose: ${precisionPanel.purpose}`,
    `- sectionNote: ${precisionPanel.sectionNote}`,
    "",
    buildPanelTable(precisionPanel.rows),
    "",
    "## Rendered Card Family",
    "",
    "- the previous single-card overlap/clipping failure was replaced by a measured multi-card family.",
    "- each subject now has a dedicated rendered card with dynamic height, wrapped notes, and wrapped badge rows.",
    "- proof hierarchy remains unchanged and visible on-card.",
    "- provenance badges remain visible on-card rather than being hidden in metadata only.",
    "- no field imagery, transport context, or volumetric render content is used in the card family.",
    "",
    buildRenderedCardsTable(payload.renderedCards),
    "",
    "## Graph Series Blocks",
    "",
    "- graphs are driven by explicit sampled series serialized into the dashboard JSON artifact.",
    "- these are provenance-aware profile graphs, not raw 2D field renders.",
    "- local clock-gradient graph remains explicitly local-only and not route-time compression.",
    "",
    buildGraphSeriesBlockTable(payload.graphSeriesBlocks),
    "",
    "## Graph Renders",
    "",
    `- graphRenderStatus: ${payload.graphRenderStatus}`,
    "- graphs are presentation-only and non-authoritative.",
    "- baseImagePolicy: diagnostic_graph_canvas",
    "- inheritsTransportContext: false",
    "- contextCompositionMode: none",
    "",
    buildGraphRendersTable(payload.graphRenders),
    "",
    "## Provenance Warnings",
    "",
    `- provenanceWarningCount: ${payload.provenanceWarnings.length}`,
    warningList,
    "",
    "## Badge Legend",
    "",
    buildBadgeLegendMarkdown(payload.badgeLegend),
    "",
    "## Source / Mechanism Consumer Conformance",
    "",
    `- consumerConformanceStatus: ${payload.sourceMechanismConsumerConformance?.consumerConformanceStatus ?? "n/a"}`,
    `- conformanceDataMode: ${payload.sourceMechanismConsumerConformance?.conformanceDataMode ?? "n/a"}`,
    `- stalenessRisk: ${payload.sourceMechanismConsumerConformance?.stalenessRisk ?? "n/a"}`,
    `- artifactCouplingNote: ${payload.sourceMechanismConsumerConformance?.artifactCouplingNote ?? "n/a"}`,
    `- checkedSurfaceCount: ${payload.sourceMechanismConsumerConformance?.checkedSurfaces.length ?? 0}`,
    `- conformantSurfaces: ${payload.sourceMechanismConsumerConformance?.conformantSurfaces.join(", ") || "none"}`,
    `- nonConformantSurfaces: ${payload.sourceMechanismConsumerConformance?.nonConformantSurfaces.join(", ") || "none"}`,
    `- referenceOnlyScopePreserved: ${payload.sourceMechanismConsumerConformance?.referenceOnlyScopePreserved ? "yes" : "no"}`,
    `- referenceOnlyMissingOnSurfaces: ${payload.sourceMechanismConsumerConformance?.referenceOnlyMissingOnSurfaces.join(", ") || "none"}`,
    `- laneAAuthorityPreserved: ${payload.sourceMechanismConsumerConformance?.laneAAuthorityPreserved ? "yes" : "no"}`,
    `- laneAAuthorityMissingOnSurfaces: ${payload.sourceMechanismConsumerConformance?.laneAAuthorityMissingOnSurfaces.join(", ") || "none"}`,
    `- summary: ${payload.sourceMechanismConsumerConformance?.summary ?? "n/a"}`,
    `- artifactPath: ${payload.sourceMechanismConsumerConformance?.artifactPath ?? "n/a"}`,
    `- reportPath: ${payload.sourceMechanismConsumerConformance?.reportPath ?? "n/a"}`,
    "",
  ].join("\n");
};

const buildMemoMarkdown = (payload: DashboardPayload) => {
  const proofPanel = panelById(payload, "proof_status_panel");
  const cabinPanel = panelById(payload, "cabin_gravity_panel");
  const wallPanel = panelById(payload, "wall_safety_panel");
  const precisionPanel = panelById(payload, "precision_panel");
  const cabinGravityGraph = payload.graphSeriesBlocks.find(
    (graph) => graph.graphId === "cabin_gravity_profile_z",
  );
  const clockGradientGraph = payload.graphSeriesBlocks.find(
    (graph) => graph.graphId === "clock_gradient_profile_z",
  );
  return [
    "# NHM2 Shift-Plus-Lapse Dashboard Memo",
    "",
    "This is a human-facing dashboard surface built directly from the provenance-aware shift-plus-lapse dashboard JSON artifact.",
    "",
    "It does not supersede proof artifacts:",
    "",
    "- Lane A remains authoritative and unchanged.",
    "- warp.metric.T00.nhm2.shift_lapse is a candidate authoritative solve family in provenance/model-selection while proof-bearing bounded transport admission remains separately controlled by the authoritative shift-lapse transport-promotion gate.",
    "- Cabin gravity and wall safety stay separate diagnostic families.",
    "- Raw brick vs analytic companion provenance remains visible on-card and on-graph.",
    "- The source/mechanism exemption route is active only for bounded non-authoritative source annotation, mechanism context, and reduced-order comparison claims.",
    "- Formula equivalence, viability promotion, authority expansion, and cross-lane expansion remain blocked.",
    "- No transport context, field-illusion heatmap, or volumetric imagery is introduced in this patch.",
    "",
    "## Why Profile Graphs Were Chosen",
    "",
    "- the mild branch already has a real local cabin-gravity signal and a correspondingly tiny local clock gradient, but those quantities were still only visible as table rows",
    "- the mild reference under-resolves in float32 raw channels, so a pseudo-precise field map would overstate what the brick actually resolves",
    "- provenance-aware line graphs are the honest first render because they show the quantity, the tiny scale, and the raw-brick versus analytic-companion split without pretending to be a resolved 2D slice",
    "",
    "## What The Graphs Communicate",
    "",
    "- `cabin_gravity_profile_z` shows how local cabin gravity is represented along the cabin z_zenith axis and makes the mild branch's nonzero local profile legible against the unit-lapse zero baseline",
    `- cabin gravity graph provenance: baseline=${cabinGravityGraph?.baselineSourceKind ?? "n/a"} | generalized=${cabinGravityGraph?.generalizedSourceKind ?? "n/a"}`,
    "- `clock_gradient_profile_z` shows the local cabin timing differential relative to the centerline and keeps the tiny scale explicit in s/day",
    `- clock gradient graph provenance: baseline=${clockGradientGraph?.baselineSourceKind ?? "n/a"} | generalized=${clockGradientGraph?.generalizedSourceKind ?? "n/a"}`,
    "- the clock graph explicitly states that it is local cabin timing only and not route-time compression",
    "",
    "## What Remains Deferred",
    "",
    "- no graph in this patch is a proof surface",
    "- no graph in this patch is a raw 2D field map",
    "- no transport-context or mechanism overlay is added",
    "- any future higher-resolution field-map presentation still needs a separate provenance and resolution argument before it should be shown",
    "- the consumer-conformance artifact now checks proof-pack JSON/markdown, dashboard JSON/markdown, rendered cards, and rendered graphs for explicit Lane A authority plus the candidate-family versus fail-closed transport split",
    `- remaining limitation: ${payload.sourceMechanismConsumerConformance?.artifactCouplingNote ?? "n/a"}`,
    "",
    `- dashboardCardFamilyStatus: ${payload.renderedCardFamilyStatus}`,
    `- graphRenderStatus: ${payload.graphRenderStatus}`,
    `- cabinGravityGraphStatus: ${cabinGravityGraph ? "generated" : "missing"}`,
    `- clockGradientGraphStatus: ${clockGradientGraph ? "generated" : "missing"}`,
    "- layoutPlanningStatus: measured_dynamic_multicard_layout",
    `- proofHierarchyStatus: ${proofPanel ? "lane_a_authoritative_and_visible" : "missing"}`,
    `- provenanceBadgeStatus: ${payload.badgeLegend.length > 0 ? "visible_on_card_and_graph_family" : "missing"}`,
    `- consumerConformanceStatus: ${payload.sourceMechanismConsumerConformance?.consumerConformanceStatus ?? "n/a"}`,
    `- consumerConformanceDataMode: ${payload.sourceMechanismConsumerConformance?.conformanceDataMode ?? "n/a"}`,
    `- consumerConformanceStalenessRisk: ${payload.sourceMechanismConsumerConformance?.stalenessRisk ?? "n/a"}`,
    "- recommendedNextAction: If a future patch attempts any field-map presentation for the mild branch, require explicit resolution/provenance justification first; otherwise keep extending only profile-level presentation surfaces.",
    "",
    `- dashboardStatus: ${payload.dashboardStatus}`,
    `- proofPanelStatus: ${proofPanel ? "available" : "missing"}`,
    `- cabinGravityPanelStatus: ${cabinPanel ? "available" : "missing"}`,
    `- wallSafetyPanelStatus: ${wallPanel ? "available" : "missing"}`,
    `- precisionPanelStatus: ${precisionPanel ? "available" : "missing"}`,
    "",
  ].join("\n");
};

const buildSourceMechanismConsumerConformanceArtifact = (args: {
  dashboard: DashboardPayload;
  dashboardAuditMarkdown: string;
  proofPackArtifact: any;
  proofPackMarkdown: string;
}): SourceMechanismConsumerConformanceArtifact => {
  const summary = buildSourceMechanismConsumerConformanceSummary({
    dashboard: args.dashboard,
    proofPackArtifact: args.proofPackArtifact,
    proofPackMarkdown: args.proofPackMarkdown,
    dashboardAuditMarkdown: args.dashboardAuditMarkdown,
  });
  const payloadBase: SourceMechanismConsumerConformanceArtifact = {
    artifactType: "nhm2_source_mechanism_consumer_conformance/v1",
    generatedOn: args.dashboard.date,
    generatedAt: new Date().toISOString(),
    boundaryStatement:
      "This consumer-conformance artifact checks proof-pack latest aliases, current dashboard JSON/markdown outputs, and current-build rendered dashboard card and graph sources to ensure the active bounded source/mechanism exemption route is not widened into broader promotion.",
    proofPackArtifact: normalizePath(PROOF_PACK_LATEST_JSON),
    proofPackReport: normalizePath(PROOF_PACK_LATEST_AUDIT),
    promotionContractArtifact: normalizePath(
      SOURCE_MECHANISM_PROMOTION_CONTRACT_LATEST_JSON,
    ),
    maturityArtifact: normalizePath(SOURCE_MECHANISM_MATURITY_LATEST_JSON),
    dashboardArtifact: normalizePath(OUT_JSON),
    dashboardReport: normalizePath(OUT_AUDIT),
    renderedCardDirectory: normalizePath(OUT_RENDER_DIR),
    sourceMechanismConsumerConformance: summary,
    notes: [
      `consumer_conformance_status=${summary.consumerConformanceStatus}; checked_surfaces=${summary.checkedSurfaces.length}; conformant_surfaces=${summary.conformantSurfaces.join(",") || "none"}; non_conformant_surfaces=${summary.nonConformantSurfaces.join(",") || "none"}.`,
      `active_claim_set=${summary.activeClaimSet.join(",") || "none"}; blocked_claim_set=${summary.blockedClaimSet.join(",") || "none"}.`,
      `reference_only_scope_preserved=${String(summary.referenceOnlyScopePreserved)}; reference_only_missing_on_surfaces=${summary.referenceOnlyMissingOnSurfaces.join(",") || "none"}; lane_a_authority_preserved=${String(summary.laneAAuthorityPreserved)}; lane_a_authority_missing_on_surfaces=${summary.laneAAuthorityMissingOnSurfaces.join(",") || "none"}.`,
      `conformance_data_mode=${summary.conformanceDataMode}; staleness_risk=${summary.stalenessRisk}.`,
    ],
  };
  return {
    ...payloadBase,
    checksum: computeSourceMechanismConsumerConformanceChecksum(payloadBase),
  };
};

export const writeShiftPlusLapseDashboardArtifacts = async (payload?: DashboardPayload) => {
  const dashboardBase = payload ?? (await buildShiftPlusLapseDashboardPayload());
  const provisionalAuditMarkdown = buildAuditMarkdown(dashboardBase);
  const proofPackArtifact = readJsonFile<any>(PROOF_PACK_LATEST_JSON);
  const proofPackMarkdown = fs.readFileSync(PROOF_PACK_LATEST_AUDIT, "utf8");
  const consumerConformanceArtifact = buildSourceMechanismConsumerConformanceArtifact({
    dashboard: dashboardBase,
    dashboardAuditMarkdown: provisionalAuditMarkdown,
    proofPackArtifact,
    proofPackMarkdown,
  });
  const dashboard: DashboardPayload = {
    ...dashboardBase,
    sourceMechanismConsumerConformance: {
      ...consumerConformanceArtifact.sourceMechanismConsumerConformance,
      artifactPath: normalizePath(OUT_SOURCE_MECHANISM_CONFORMANCE_JSON),
      reportPath: normalizePath(OUT_SOURCE_MECHANISM_CONFORMANCE_AUDIT),
    },
  };
  const auditMarkdown = buildAuditMarkdown(dashboard);
  const memoMarkdown = buildMemoMarkdown(dashboard);
  ensureDirForFile(OUT_JSON);
  ensureDirForFile(OUT_AUDIT);
  ensureDirForFile(OUT_MEMO);
  ensureDirForFile(OUT_SOURCE_MECHANISM_CONFORMANCE_JSON);
  ensureDirForFile(OUT_SOURCE_MECHANISM_CONFORMANCE_AUDIT);
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(dashboard, null, 2)}\n`, "utf8");
  fs.writeFileSync(OUT_AUDIT, auditMarkdown, "utf8");
  fs.writeFileSync(OUT_MEMO, memoMarkdown, "utf8");
  fs.writeFileSync(
    OUT_SOURCE_MECHANISM_CONFORMANCE_JSON,
    `${JSON.stringify(consumerConformanceArtifact, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    OUT_SOURCE_MECHANISM_CONFORMANCE_AUDIT,
    buildSourceMechanismConsumerConformanceMarkdown(consumerConformanceArtifact),
    "utf8",
  );
  const taxonomyOutputs = updateRenderTaxonomyArtifacts(dashboard);
  return {
    outJson: OUT_JSON,
    outAudit: OUT_AUDIT,
    outMemo: OUT_MEMO,
    outSourceMechanismConsumerConformanceJson: OUT_SOURCE_MECHANISM_CONFORMANCE_JSON,
    outSourceMechanismConsumerConformanceAudit: OUT_SOURCE_MECHANISM_CONFORMANCE_AUDIT,
    outRenderedCards: dashboard.renderedCards.map((card) => path.join(ROOT, card.path)),
    outRenderedGraphs: dashboard.graphRenders.map((graph) => path.join(ROOT, graph.path)),
    ...taxonomyOutputs,
  };
};

const run = async () => {
  const comparison = await buildShiftPlusLapseComparisonPayload();
  writeShiftPlusLapseComparisonArtifacts(comparison);
  const dashboard = await buildShiftPlusLapseDashboardPayload(comparison);
  const outputs = await writeShiftPlusLapseDashboardArtifacts(dashboard);
  process.stdout.write(`${JSON.stringify({ ok: true, ...outputs }, null, 2)}\n`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
