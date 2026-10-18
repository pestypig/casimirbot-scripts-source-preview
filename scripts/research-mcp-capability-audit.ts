import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import ts from "typescript";
import { RESEARCH_CAPABILITIES } from "../shared/research-mcp";

const root = process.cwd();
const sourcePath = "server/mcp/helix-mcp-server.ts";
const source = fs.readFileSync(path.join(root, sourcePath), "utf8");
const parsed = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
const registrations = new Map<string, { name: string; lines: number[]; read_only_hints: Array<boolean | null> }>();
const unresolved: Array<{ line: number; expression: string }> = [];
const visit = (node: ts.Node) => {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
    ["registerTool", "tool"].includes(node.expression.name.text)) {
    const arg = node.arguments[0];
    const line = parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1;
    if (arg && ts.isStringLiteralLike(arg)) {
      const config = node.arguments[1]?.getText(parsed) ?? "";
      const hint = /readOnlyHint\s*:\s*(true|false)/u.exec(config);
      const entry = registrations.get(arg.text) ?? { name: arg.text, lines: [], read_only_hints: [] };
      entry.lines.push(line); entry.read_only_hints.push(hint ? hint[1] === "true" : null);
      registrations.set(arg.text, entry);
    } else unresolved.push({ line, expression: arg?.getText(parsed) ?? "<missing>" });
  }
  ts.forEachChild(node, visit);
};
visit(parsed);

// Triage is deliberately separate from the reviewed runtime allowlist.
// Prefixes organize follow-up review; they grant no capability.
const triage = (name: string) => {
  const noAdmission = { gateway_admitted: false, provider_cost: "unreviewed", handler_effect: "unreviewed",
    review: "source_name_triage_only", source: sourcePath };
  if (name === "helix_yb171_clock_theory_proposal") return { ...noAdmission,
    category: "extracted_static_reference", data_owner: "curated_research",
    dependencies: ["static theory graph and analytic design code"],
    next_review: "Only selected static badges are admitted through theory.yb171.context; the source handler is not called." };
  if (name === "helix_solar_magnetic_bundle_get") return { ...noAdmission,
    category: "extracted_calculation", data_owner: "profile_owner",
    dependencies: ["authorized owner bundle reader", "shared solar projection functions"],
    next_review: "Only caller-supplied map projection is admitted as solar.equivalent_dipole; owner retrieval requires a separate data grant." };
  if (/^helix_(nhm2|yb171)_/u.test(name)) return { ...noAdmission,
    category: "theory_or_archived_evidence_candidate", data_owner: "research_owner",
    dependencies: ["selected graph or pinned artifact", "current scientific work program"],
    next_review: "Review exact reference selection, frozen status, artifact custody and research disclosure. No proof execution or gate promotion." };
  if (/^helix_civilization_/u.test(name)) return { ...noAdmission,
    category: "domain_evidence_candidate", data_owner: "mixed_provider_and_profile",
    dependencies: ["handler-specific data cache or external API", "provenance and provider terms"],
    next_review: "Review each handler's network calls, paid keys, quotas, data rights, cache freshness and owner-specific records." };
  if (/^helix_solar_/u.test(name)) return { ...noAdmission,
    category: /show|import_request/u.test(name) ? "ui_or_import_excluded" : "solar_evidence_candidate",
    data_owner: "profile_owner_or_upstream_provider",
    dependencies: ["owner package/archive stores or provider", "handler-specific projection"],
    next_review: "Separate numerical evidence from globe UI; approve exact records or bounded provider adapters before exposure." };
  if (/^helix_spaceengine_/u.test(name)) return { ...noAdmission,
    category: "installed_artifact_candidate", data_owner: "installation_owner",
    dependencies: ["local installation, artifacts or scene compiler"],
    next_review: "Extract an in-memory compiler only after a dependency and artifact disclosure review; no local path or launch control." };
  if (/^helix_(public_ui|surface|visual_sequence|realtime_texture|workstation)_/u.test(name)) return { ...noAdmission,
    category: "desktop_surface_excluded", data_owner: "installation_owner",
    dependencies: ["workstation metadata, screenshots, UI projections or control"],
    next_review: "Keep desktop controls out. A selected metadata resource would require independent review." };
  if (/brokerage|private_clock/u.test(name)) return { ...noAdmission,
    category: "sensitive_private_connector_excluded", data_owner: "connector_owner",
    dependencies: ["private device/account data and authority"],
    next_review: "Not part of the research gateway; separate owner, data and operational authority." };
  if (/room|environment|minecraft|authority|resident|reflex|semantic_wake/u.test(name)) return { ...noAdmission,
    category: "room_or_program_authority_excluded", data_owner: "room_or_program_owner",
    dependencies: ["membership, installation or selected program authority"],
    next_review: "Retain the existing harness authority path; future observation relay needs an exact owner/device/data grant." };
  if (/supervisor|reasoning|agent_run|pair|binding|tunnel|client_authorization|handshake/u.test(name)) return { ...noAdmission,
    category: "coordination_or_administration_excluded", data_owner: "account_and_task_owner",
    dependencies: ["authenticated client, task, session or tunnel stores"],
    next_review: "Do not inherit account, task-binding, session, credential or tunnel administration in a research grant." };
  return { ...noAdmission, category: "handler_review_required", data_owner: "unreviewed",
    dependencies: ["handler dependencies unreviewed"], next_review: "Trace actual inputs, outputs, effects, owner data and costs before selecting." };
};
const audit = {
  schema: "casimirbot.research.source_inventory.v1", source: sourcePath,
  source_sha256: crypto.createHash("sha256").update(source).digest("hex"),
  unique_literal_tool_names: registrations.size, unresolved_registrations: unresolved,
  limits: "Static source triage only. Conditional and dynamic registrations are not resolved. This is neither a live catalog nor admission from readOnlyHint.",
  source_tools: [...registrations.values()].sort((a, b) => a.name.localeCompare(b.name))
    .map(entry => ({ ...entry, ...triage(entry.name) })),
  reviewed_gateway: RESEARCH_CAPABILITIES,
};
const args = process.argv.slice(2);
if (args.length === 0) console.log(JSON.stringify(audit, null, 2));
else if (args.length === 2 && args[0] === "--out") {
  const target = path.resolve(root, args[1]);
  const allowed = path.resolve(root, "docs/evidence/eh-g8-research-mcp-gateway-v1");
  const relative = path.relative(allowed, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || path.extname(target) !== ".json")
    throw new Error("Audit output must be an explicitly named JSON file inside the research gateway evidence directory.");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(audit, null, 2) + "\n");
  console.log(JSON.stringify({ unique_literal_tool_names: registrations.size,
    unresolved_registrations: unresolved.length, reviewed_gateway_tools: RESEARCH_CAPABILITIES.length, output: args[1] }));
} else throw new Error("Usage: npx tsx scripts/research-mcp-capability-audit.ts [--out docs/evidence/eh-g8-research-mcp-gateway-v1/<file>.json]");
