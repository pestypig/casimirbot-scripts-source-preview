import { z } from "zod";
import {
  helixLocalSupervisorOriginSelectionSchema,
  helixLocalSupervisorStatusSchema,
} from "../shared/helix-local-supervisor";
import { verifyHelixLocalSupervisorPostBind } from
  "../server/services/local-supervisor/local-supervisor-post-bind-verification";

const requestSchema = z.object({
  schema: z.literal("helix.local_supervisor_post_bind_verification_request.v1"),
  expected_workspace_ref: z.string().regex(/^workspace:[a-f0-9]{64}$/u),
  selection: helixLocalSupervisorOriginSelectionSchema,
  observed_origin: z.string().min(1).max(96),
  atomic_bind_claimed: z.boolean(),
  listener_present: z.boolean(),
  status: helixLocalSupervisorStatusSchema.nullable(),
}).strict();

const chunks: Buffer[] = [];
let byteLength = 0;
for await (const chunk of process.stdin) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  byteLength += buffer.byteLength;
  if (byteLength > 64 * 1024) {
    throw new Error("Post-bind verification input is too large.");
  }
  chunks.push(buffer);
}

try {
  const request = requestSchema.parse(
    JSON.parse(Buffer.concat(chunks).toString("utf8")),
  );
  const result = verifyHelixLocalSupervisorPostBind({
    expectedWorkspaceRef: request.expected_workspace_ref,
    selection: request.selection,
    observedOrigin: request.observed_origin,
    atomicBindClaimed: request.atomic_bind_claimed,
    listenerPresent: request.listener_present,
    status: request.status,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.decision === "fail_closed" ? 2 : 0;
} catch {
  process.stdout.write(`${JSON.stringify({
    schema: "helix.local_supervisor_post_bind_verification_error.v1",
    ok: false,
    error: "invalid_post_bind_verification_request",
    credential_included: false,
    private_network_endpoint_included: false,
    workspace_path_included: false,
    process_identity_included: false,
    account_identity_included: false,
    answer_authority: false,
    terminal_eligible: false,
  }, null, 2)}\n`);
  process.exitCode = 2;
}
