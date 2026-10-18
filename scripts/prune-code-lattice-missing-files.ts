import fs from "node:fs";
import path from "node:path";

type Node = { nodeId: string; filePath: string; snippet?: string; [key: string]: unknown };
type Edge = { from: string; to: string };
type Envelope = { header?: { id?: string; source?: { uri?: string } }; [key: string]: unknown };
type Snapshot = {
  nodes: Node[];
  edges: Edge[];
  envelopes: Envelope[];
  [key: string]: unknown;
};

const root = process.cwd();
const target = path.resolve(root, "server/_generated/code-lattice.json");
const snapshot = JSON.parse(fs.readFileSync(target, "utf8")) as Snapshot;
const retiredTokens = [
  "CavityMechanismPanel",
  "MassProvenancePanel",
  "NeedleMk2CalculatorPanel",
  "PotatoThresholdLab",
  "potato-threshold-lab",
  "CollapseBenchmarkHUDPanel",
  "SpectrumTunerPanel",
  "VacuumGapSweepHUD",
  "LiveEnergyPipeline",
  "BridgeDerivationCards",
  "pages/home.tsx",
  "GrAgentLoopKpiPanel",
  "GrAgentLoopLearningPanel",
  "PhoenixNeedlePanel",
  "PhoenixBadge",
  "helix-phoenix",
  "HelixCasimirAmplifier",
  "CavityFrameView",
  "helix-casimir-amplifier",
  "vacuum-gap-heatmap",
  "sweep-replay",
  "BusVoltagePanel",
  "PulsedPowerDocPanel",
  "MicroscopyPanel",
  "useMicroscopy",
  "CurvatureSlicePanel",
  "SliceViewer",
  "SectorRolesHud",
  "SectorLegend",
  "SectorGridRing",
  "CurvatureLedgerPanel",
  "useCycleLedger",
  "LightSpeedStrobeScale",
  "QiWidget",
  "FractionalCoherenceRail",
  "NearZeroWidget",
  "ShellOutlineVisualizer",
  "SpeedCapabilityPanel",
  "ResonanceSchedulerTile",
  "TripPlayer",
  "ObservableUniverseAccordionPanel",
  "NeedleWorldRoadmap",
  "FuelGauge",
  "RouteSteps",
  "route-math.ts",
  "lib/eta.ts",
  "NeedleCavityBubblePanel",
  "AmplificationPanel",
  "BubbleFieldPanel",
  "CurvaturePhysicsPanel",
  "CurvatureTensorPanel",
  "MetricAmplificationPocket",
  "WarpBubbleGLPanel",
  "WarpBubbleLivePanel",
  "CardProofOverlay",
  "QiGuardBadge",
  "QiLatticePanel",
  "lattice/field.ts",
  "lattice/diffuse.ts",
  "CavityCrossSectionSplit",
  "CavitySideView",
  "cavityScaling",
  "CasimirTileGridPanel",
  "WarpLedgerPanel",
  "DesignLedger",
  "VisualProofCharts",
  "VerificationTab",
  "design-ledger",
  "visual-proof-charts",
  "verification-tab",
  "DynamicDashboard",
  "DynamicValuesTable",
  "DynamicVisualization",
  "dynamic-dashboard",
  "dynamic-values-table",
  "dynamic-visualization",
  "ChartVisualization",
  "chart-visualization",
  "km-scale-warp-ledger",
  "documentation.tsx",
  "WarpRenderInspector",
  "MarginHunterPanel",
  "fractional-coherence-rail",
  "fractional-coherence-grid",
  "curvature-slice",
  "sector-roles",
  "sector-legend",
  "curvature-ledger",
  "light-speed-strobe",
  "qi-widget",
  "bus-voltage",
  "pulsed-power-doc",
  "StressMapPanel",
  "StressOverlay",
  "helixQiRouter",
  "qi-diagnostics-schema",
  "stress-map",
  "PhaseDiagram",
  "CollapseWatcherPanel",
  "collapse-monitor",
  "GalaxyDeepZoom",
  "GalaxyMapPanZoom",
  "GalaxyOverlays",
  "GalaxyTextOverlay",
];
const currentSourceCache = new Map<string, string>();
const rewrittenSourcePaths = new Set([
  "client/src/components/QiAutoTunerPanel.tsx",
  "client/src/components/DirectionPad.tsx",
  "client/src/components/ElectronOrbitalPanel.tsx",
  "client/src/components/EnergyFluxPanel.tsx",
  "client/src/components/DriveGuardsPanel.tsx",
  "client/src/components/PipelineProofPanel.tsx",
  "scripts/agi-seed-mine.ts",
  "client/src/components/TimeDilationLatticePanel.tsx",
  "client/src/components/nhm2/Nhm2DiagnosticShelf.tsx",
  "client/src/components/FractionalCoherenceGrid.tsx",
  "client/src/hooks/useFractionalCoherence.ts",
  "server/services/telemetry/badges.ts",
  "client/src/pages/helix-core.panels.ts",
  "client/src/lib/whispers/seedWhispers-ethos.ts",
  "client/src/lib/whispers/seedWhispers.ts",
  "client/src/components/results-panel.tsx",
  "client/src/hooks/use-energy-pipeline.ts",
  "client/src/hooks/use-phase-bridge.ts",
  "client/src/hooks/useSectorRingCoordinator.ts",
  "client/src/components/OperationalModePanel.tsx",
  "server/services/warp/visual-orchestrator.ts",
  "shared/helix-account-session.ts",
  "client/src/lib/nav/nav-dynamics.ts",
  "client/src/components/NavPoseHUD.tsx",
  "client/src/lib/galaxy-schema.ts",
  "client/src/components/PipelineProofPanel.tsx",
]);

const hasStaleRewrittenSnippet = (node: Node): boolean => {
  if (!rewrittenSourcePaths.has(node.filePath) || typeof node.snippet !== "string") return false;
  const sourcePath = path.resolve(root, node.filePath);
  if (!fs.existsSync(sourcePath)) return true;
  const normalizedSnippet = node.snippet.replace(/\s+/g, " ").trim();
  const normalizedSource = fs.readFileSync(sourcePath, "utf8").replace(/\s+/g, " ");
  return Boolean(normalizedSnippet) && !normalizedSource.includes(normalizedSnippet);
};

const hasStaleRetiredSnippet = (node: Node): boolean => {
  if (typeof node.snippet !== "string") return false;
  const mentioned = retiredTokens.filter((token) => node.snippet!.includes(token));
  if (mentioned.length === 0) return false;
  let currentSource = currentSourceCache.get(node.filePath);
  if (currentSource === undefined) {
    const sourcePath = path.resolve(root, node.filePath);
    currentSource = fs.existsSync(sourcePath) ? fs.readFileSync(sourcePath, "utf8") : "";
    currentSourceCache.set(node.filePath, currentSource);
  }
  return mentioned.some((token) => !currentSource!.includes(token));
};

if (!Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.edges) || !Array.isArray(snapshot.envelopes)) {
  throw new Error("Code lattice nodes, edges, and envelopes are required arrays.");
}

const missingPaths = new Set(
  snapshot.nodes
    .map((node) => node.filePath)
    .filter((filePath) => typeof filePath === "string" && !fs.existsSync(path.resolve(root, filePath))),
);
const removedIds = new Set(
  snapshot.nodes
    .filter((node) => missingPaths.has(node.filePath) ||
      (typeof node.snippet === "string" && [...missingPaths].some((filePath) => node.snippet!.includes(filePath))) ||
      hasStaleRetiredSnippet(node) ||
      hasStaleRewrittenSnippet(node))
    .map((node) => node.nodeId),
);

if (removedIds.size === 0) {
  console.log("[code-lattice] no missing source files to prune");
  process.exit(0);
}

const scrubReferences = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value
      .filter((entry) => {
        if (typeof entry === "string") return !removedIds.has(entry);
        if (!entry || typeof entry !== "object") return true;
        const record = entry as Record<string, unknown>;
        return !(typeof record.nodeId === "string" && removedIds.has(record.nodeId)) &&
          !(typeof record.filePath === "string" && missingPaths.has(record.filePath));
      })
      .map(scrubReferences);
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, scrubReferences(entry)]),
  );
};

snapshot.nodes = snapshot.nodes
  .filter((node) => !removedIds.has(node.nodeId))
  .map((node) => scrubReferences(node) as Node);
snapshot.edges = snapshot.edges.filter((edge) => !removedIds.has(edge.from) && !removedIds.has(edge.to));
snapshot.envelopes = snapshot.envelopes
  .filter((envelope) => !missingPaths.has(envelope.header?.source?.uri ?? "") &&
    !removedIds.has((envelope.header?.id ?? "").replace(/^code:/, "")))
  .map((envelope) => scrubReferences(envelope) as Envelope);

if (snapshot.envelopes.length !== snapshot.nodes.length) {
  throw new Error("Code lattice envelope/node count changed inconsistently; original artifact was not rewritten.");
}

const output = JSON.stringify(snapshot, null, 2);
fs.writeFileSync(target, output);
console.log(
  `[code-lattice] pruned ${removedIds.size} nodes from ${missingPaths.size} missing files; ` +
  `${snapshot.nodes.length} nodes, ${snapshot.edges.length} edges remain`,
);
