import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import * as process from "node:process";

type Severity = "P0" | "P1" | "P2";
type P2Bucket =
  | "P2_REAL_PROJECTION_RISK"
  | "P2_ACTION_EXECUTION_RISK"
  | "P2_LEGACY_COMPATIBILITY"
  | "P2_AUDIT_SELF_REFERENCE";

type Finding = {
  severity: Severity;
  procedural_role: ProceduralRole;
  p2_bucket?: P2Bucket;
  code: string;
  file: string;
  line: number;
  text: string;
  reason: string;
};

type ProceduralRole =
  | "authority_writer"
  | "backend_serializer_or_materializer"
  | "client_projection"
  | "debug_only_mirror"
  | "legacy_compatibility"
  | "unclassified";

const args = new Set(process.argv.slice(2));
const strict = args.has("--strict");
const json = args.has("--json");
const repoRoot = process.cwd();

const scanRoots = [
  "server/routes/agi.plan.ts",
  "server/services/helix-ask",
  "client/src/components/helix",
  "client/src/components/panels",
  "client/src/store",
  "scripts",
];

const terminalWritePattern =
  /\b(?:selected_final_answer|final_answer_source|terminal_answer_authority|terminal_presentation|terminal_artifact_kind|terminal_error_code|final_status|response_type|typed_failure)\b(?:\s*:(?!:)|\s*(?<![=!<>])=(?!=))/;
const actionWritePattern = /\b(?:workspace_action|action_envelope)\b(?:\s*:(?!:)|\s*(?<![=!<>])=(?!=))/;
const shortcutPattern = /\b(?:all_subgoals_observed|model_only_concept|reasoning_only|no_tool_direct|direct_answer_text)\b/;
const boundaryCallPattern =
  /\b(?:applyTerminalAnswerEnvelope|recordHelixTurnTerminalAuthority|buildHelixTurnTerminalAuthority|enforceHelixTerminalAuthority|auditHelixAskContextForPoison)\b/;

const approvedTerminalBoundaryFiles = new Set([
  "server/services/helix-ask/terminal-answer-envelope.ts",
  "server/services/helix-ask/terminal-authority-single-writer.ts",
  "server/services/helix-ask/runtime-authority-contract.ts",
  "server/services/helix-ask/turn-terminal-authority.ts",
]);

const approvedAuditFiles = new Set([
  "scripts/helix-ask-runtime-authority-audit.ts",
  "scripts/helix-ask-terminal-writer-audit.ts",
  "scripts/helix-ask-discipline-check.ts",
]);

const readOnlyDiagnosticFilePattern =
  /(?:^scripts\/|(?:^|\/)(?:api-parity-matrix|api-parity-probe|ask-context-poison-audit|ask-turn-solver|loop-parity-trace|objective-loop-debug|product-authority-guard|route-authority-audit|situation-context-turn-router|solver-artifact-reentry-audit|terminal-artifact-selection-guard|terminal-equivalence-harness|terminal-presentation-coverage-audit|universal-terminal-presenter)\.ts$)/;

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function readUtf8(file: string): string | null {
  const absolute = path.join(repoRoot, file);
  if (!existsSync(absolute)) return null;
  const stat = statSync(absolute);
  if (!stat.isFile() || stat.size > 1_800_000) return null;
  return readFileSync(absolute, "utf8");
}

function collectFiles(root: string): string[] {
  const absolute = path.join(repoRoot, root);
  if (!existsSync(absolute)) return [];
  const stat = statSync(absolute);
  if (stat.isFile()) return [normalizePath(root)];
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
      const rel = normalizePath(path.join(dir, entry.name));
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "coverage") continue;
        visit(rel);
      } else if (/\.(?:ts|tsx)$/.test(entry.name)) {
        out.push(rel);
      }
    }
  };
  visit(normalizePath(root));
  return out;
}

function lineHasRuntimeGuard(line: string): boolean {
  return /assertTerminalBoundaryEligible|evaluateTerminalBoundaryEligibility|terminal_boundary_eligibility|agent_runtime_loop|agent_step_decision|goal_satisfaction_evaluation|runtime_authority/i.test(line);
}

function fileContextAllowsWrite(file: string, content: string): boolean {
  if (approvedTerminalBoundaryFiles.has(file)) return true;
  if (approvedAuditFiles.has(file)) return true;
  return /runtime-authority|terminal boundary|boundary eligibility/i.test(content.slice(0, 2000));
}

function isClientProjectionFile(file: string): boolean {
  return file.startsWith("client/");
}

function proceduralRoleForFile(file: string): ProceduralRole {
  if (file.startsWith("client/")) {
    return file.includes("HelixAskPill") || file.includes("ask-console/")
      ? "legacy_compatibility"
      : "client_projection";
  }
  if (file === "server/services/helix-ask/terminal-authority-single-writer.ts" ||
      file === "server/services/helix-ask/turn-terminal-authority.ts") {
    return "authority_writer";
  }
  if (/server\/services\/helix-ask\/(?:turn-finalizer|solver-controller-payload-adapter|runtime-final-answer-composer|solver-hard-gate-terminal-candidate|terminal-product-materializers|scholarly-terminal-authority-refresh)\.ts$/.test(file)) {
    return "backend_serializer_or_materializer";
  }
  if (/server\/services\/helix-ask\/(?:debug\/|golden-path\/|agent-providers\/provider-response-projection\.ts$)/.test(file) ||
      file === "client/src/lib/agi/debugExport.ts") {
    return "debug_only_mirror";
  }
  return "unclassified";
}

function isAuditSelfReference(file: string): boolean {
  return approvedAuditFiles.has(file);
}

function isClientProjectionCompatibilityLine(file: string, trimmed: string): boolean {
  if (!isClientProjectionFile(file)) return false;
  if (/resolveHelixVisibleTerminal|terminalResolution|visibleTerminal|visibleResolvedTurn|debug|parity|snapshot|export|invariant|chat_backend_observation|backend_ask|result\.(?:final_answer_source|terminal_artifact_kind|terminal_error_code)/i.test(trimmed)) {
    return true;
  }
  return /^\w[\w$]*:\s*/.test(trimmed);
}

function isGuardedCodexActionEnvelopeProjection(file: string, content: string, trimmed: string): boolean {
  if (file !== "server/services/helix-ask/agent-providers/codex-provider.ts") return false;
  if (!/action_envelope\s*:\s*actionEnvelope/.test(trimmed)) return false;
  return (
    content.includes('answer_authority: "none"') &&
    content.includes("terminal_eligible: false") &&
    content.includes("buildCodexActionEnvelopeFromReceipts")
  );
}

function isReadOnlyDiagnosticFile(file: string): boolean {
  return readOnlyDiagnosticFilePattern.test(file);
}

function isDeclarationOnlyLine(trimmed: string): boolean {
  return /^[A-Za-z_$][\w$]*\??:\s*(?:string|number|boolean|null|unknown|Record<|Array<|readonly|Helix|Ask|Terminal|Payload|Debug|[A-Z][\w$]*)(?:[<\w\s,.$[\]|?{}:'"-]*)?[;,]?$/.test(trimmed);
}

function isBoundaryCallDefinitionOrImport(trimmed: string): boolean {
  return /^import\b/.test(trimmed) || /^export\s+function\b/.test(trimmed) || /^function\b/.test(trimmed);
}

function classifyFinding(file: string, content: string, lineNumber: number, line: string, declarationDepth: number): Finding | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*")) return null;
  if (/type |interface |expect\(|toBe|toEqual|describe\(|it\(/.test(trimmed)) return null;
  if (declarationDepth > 0 && isDeclarationOnlyLine(trimmed)) return null;
  if (/__tests__/.test(file)) return null;

  if (terminalWritePattern.test(trimmed)) {
    if (fileContextAllowsWrite(file, content) || lineHasRuntimeGuard(trimmed)) return null;
    if (isReadOnlyDiagnosticFile(file)) return null;
    if (isClientProjectionFile(file)) {
      return {
        severity: "P2",
        procedural_role: "client_projection",
        p2_bucket: isClientProjectionCompatibilityLine(file, trimmed)
          ? "P2_LEGACY_COMPATIBILITY"
          : "P2_REAL_PROJECTION_RISK",
        code: "client_terminal_projection_legacy_field",
        file,
        line: lineNumber,
        text: trimmed,
        reason: "Client projection references legacy terminal fields. It should prefer guarded terminal envelope/authority state and must not become backend truth.",
      };
    }
    return {
      severity: "P1",
      procedural_role: proceduralRoleForFile(file),
      code: "terminal_write_outside_boundary",
      file,
      line: lineNumber,
      text: trimmed,
      reason: "Terminal-visible state is written outside the guarded terminal boundary. Verify this is a candidate/hint only or route it through terminal-answer-envelope with runtime authority evidence.",
    };
  }

  if (actionWritePattern.test(trimmed)) {
    if (isGuardedCodexActionEnvelopeProjection(file, content, trimmed)) return null;
    if (declarationDepth > 0 && isDeclarationOnlyLine(trimmed)) return null;
    if (lineHasRuntimeGuard(trimmed) || /debug|test|snapshot|type|interface/i.test(trimmed)) return null;
    return {
      severity: "P0",
      procedural_role: proceduralRoleForFile(file),
      code: "action_write_without_agent_step_guard",
      file,
      line: lineNumber,
      text: trimmed,
      reason: "Workspace action state can become executable without a nearby agent_step_decision/runtime guard.",
    };
  }

  if (boundaryCallPattern.test(trimmed) && !approvedTerminalBoundaryFiles.has(file) && !approvedAuditFiles.has(file)) {
    if (isBoundaryCallDefinitionOrImport(trimmed)) return null;
    return {
      severity: "P1",
      procedural_role: proceduralRoleForFile(file),
      code: "terminal_authority_boundary_callsite",
      file,
      line: lineNumber,
      text: trimmed,
      reason: "Authority/envelope APIs should be response-boundary only. Confirm the call happens after runtime loop, goal satisfaction, and post-observation decision.",
    };
  }

  if (shortcutPattern.test(trimmed) && !/candidate|forbidden|test|contract|type|interface/i.test(trimmed)) {
    return {
      severity: "P2",
      procedural_role: proceduralRoleForFile(file),
      p2_bucket: isAuditSelfReference(file) ? "P2_AUDIT_SELF_REFERENCE" : "P2_LEGACY_COMPATIBILITY",
      code: "legacy_shortcut_marker",
      file,
      line: lineNumber,
      text: trimmed,
      reason: "Legacy shortcut language can obscure whether the model-owned runtime loop actually decided the turn.",
    };
  }

  return null;
}

const files = Array.from(new Set(scanRoots.flatMap(collectFiles))).sort();
const findings: Finding[] = [];

for (const file of files) {
  const content = readUtf8(file);
  if (!content) continue;
  const lines = content.split(/\r?\n/);
  let declarationDepth = 0;
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    const startsDeclaration = /^(?:export\s+)?(?:type|interface)\b/.test(trimmed);
    const activeDeclarationDepth = declarationDepth;
    const finding = classifyFinding(file, content, index + 1, line, activeDeclarationDepth);
    if (finding) findings.push(finding);
    if (startsDeclaration) declarationDepth = Math.max(declarationDepth, 1);
    if (declarationDepth > 0) {
      const openCount = (line.match(/{/g) ?? []).length;
      const closeCount = (line.match(/}/g) ?? []).length;
      declarationDepth += openCount - closeCount;
      if (/^(?:export\s+)?type\b/.test(trimmed) && /;\s*$/.test(trimmed)) declarationDepth = 0;
      if (declarationDepth < 0) declarationDepth = 0;
    }
  });
}

const p0 = findings.filter((finding) => finding.severity === "P0");
const p1 = findings.filter((finding) => finding.severity === "P1");
const p2 = findings.filter((finding) => finding.severity === "P2");
const p2Buckets: Record<P2Bucket, number> = {
  P2_REAL_PROJECTION_RISK: 0,
  P2_ACTION_EXECUTION_RISK: 0,
  P2_LEGACY_COMPATIBILITY: 0,
  P2_AUDIT_SELF_REFERENCE: 0,
};
const proceduralRoles: Record<ProceduralRole, number> = {
  authority_writer: 0,
  backend_serializer_or_materializer: 0,
  client_projection: 0,
  debug_only_mirror: 0,
  legacy_compatibility: 0,
  unclassified: 0,
};
for (const finding of findings) {
  if (finding.p2_bucket) p2Buckets[finding.p2_bucket] += 1;
  proceduralRoles[finding.procedural_role] += 1;
}

if (json) {
  console.log(JSON.stringify({ schema: "helix.ask.runtime_authority_audit.v1", finding_count: findings.length, counts: { P0: p0.length, P1: p1.length, P2: p2.length, ...p2Buckets, procedural_roles: proceduralRoles }, findings }, null, 2));
} else {
  console.log(`Helix Ask runtime authority audit: ${findings.length} findings (P0=${p0.length}, P1=${p1.length}, P2=${p2.length}, P2_REAL_PROJECTION_RISK=${p2Buckets.P2_REAL_PROJECTION_RISK}, P2_ACTION_EXECUTION_RISK=${p2Buckets.P2_ACTION_EXECUTION_RISK})`);
  console.log(`Procedural roles: ${Object.entries(proceduralRoles).map(([role, count]) => `${role}=${count}`).join(", ")}`);
  for (const finding of findings.slice(0, 120)) {
    console.log(`${finding.severity} ${finding.code} ${finding.file}:${finding.line}`);
    console.log(`  ${finding.text.slice(0, 220)}`);
    console.log(`  ${finding.reason}`);
  }
  if (findings.length > 120) console.log(`... ${findings.length - 120} additional findings omitted; rerun with --json for full output.`);
}

if (strict && (p0.length > 0 || p1.length > 0)) {
  process.exit(1);
}
