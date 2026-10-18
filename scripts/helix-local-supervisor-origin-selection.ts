import { z } from "zod";
import { helixLocalSupervisorStatusSchema } from
  "../shared/helix-local-supervisor";
import { selectHelixLocalSupervisorOrigin } from
  "../server/services/local-supervisor/local-supervisor-origin-selection";

const requestSchema = z.object({
  schema: z.literal("helix.local_supervisor_origin_selection_request.v1"),
  expected_workspace_ref: z.string().regex(/^workspace:[a-f0-9]{64}$/u),
  candidates: z.array(z.object({
    origin: z.string().min(1).max(96),
    occupancy: z.enum(["free", "listener"]),
    ownership: z.enum(["none", "verified_owned", "foreign_or_unknown"]),
    status: helixLocalSupervisorStatusSchema.nullable(),
  }).strict()).min(1).max(16),
}).strict();

const chunks: Buffer[] = [];
let byteLength = 0;
for await (const chunk of process.stdin) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  byteLength += buffer.byteLength;
  if (byteLength > 64 * 1024) {
    throw new Error("Local supervisor origin-selection input is too large.");
  }
  chunks.push(buffer);
}

try {
  const request = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  const result = selectHelixLocalSupervisorOrigin({
    expectedWorkspaceRef: request.expected_workspace_ref,
    candidates: request.candidates,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.decision === "fail_closed" ? 2 : 0;
} catch {
  process.stdout.write(`${JSON.stringify({
    schema: "helix.local_supervisor_origin_selection_error.v1",
    ok: false,
    error: "invalid_selection_request",
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
