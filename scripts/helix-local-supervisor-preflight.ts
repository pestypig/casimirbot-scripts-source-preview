import path from "node:path";
import {
  helixLocalSupervisorStatusSchema,
  type HelixLocalSupervisorStatus,
} from
  "../shared/helix-local-supervisor";
import { decideHelixLocalSupervisorAttachment } from
  "../server/services/local-supervisor/local-supervisor-attachment";
import { helixWorkspaceRefFor } from
  "../server/services/local-supervisor/local-supervisor-identity";

const baseUrlValue = process.argv[2] ?? "http://127.0.0.1:1522";
const workspacePath = process.argv[3] ?? process.cwd();
const baseUrl = new URL(baseUrlValue);
if (
  baseUrl.protocol !== "http:" ||
  baseUrl.hostname !== "127.0.0.1" ||
  !baseUrl.port ||
  baseUrl.username ||
  baseUrl.password ||
  baseUrl.pathname !== "/" ||
  baseUrl.search ||
  baseUrl.hash
) {
  throw new Error("Supervisor preflight requires an exact HTTP 127.0.0.1 origin.");
}

let listenerPresent = false;
let status: HelixLocalSupervisorStatus | null = null;
try {
  const response = await fetch(
    new URL("/api/local-supervisor/status", baseUrl),
    { cache: "no-store", signal: AbortSignal.timeout(2_000) },
  );
  listenerPresent = true;
  const parsed = helixLocalSupervisorStatusSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (parsed.success) status = parsed.data;
} catch {
  listenerPresent = false;
}

const expectedWorkspaceRef = helixWorkspaceRefFor(path.resolve(workspacePath));
const result = decideHelixLocalSupervisorAttachment({
  expectedWorkspaceRef,
  status,
  listenerPresent,
});

process.stdout.write(`${JSON.stringify({
  schema: "helix.local_supervisor_preflight.v1",
  ...result,
  listener_present: listenerPresent,
  status_valid: status !== null,
  workspace_match: status?.workspace_ref === expectedWorkspaceRef,
  service_instance_ref: status?.service_instance_ref ?? null,
  supervisor_mode: status?.supervisor_mode ?? null,
  ready: status?.ready ?? false,
  credential_included: false,
  private_endpoint_included: false,
  workspace_path_included: false,
  process_identity_included: false,
  status_is_authority: false,
}, null, 2)}\n`);

process.exitCode = result.decision === "fail_closed" ? 2 : 0;
