import { ensureDatabase, getPool } from "../server/db/client";
import { provisionPrivateDeveloperManagedAiTerm } from
  "../server/services/helix-account/managed-ai-developer-provision";
import { isManagedAiPrivateOwnerProfileId } from
  "../server/services/helix-account/managed-ai-private-owner-id";

const ownerProfileId = process.env.CASIMIR_MANAGED_AI_PRIVATE_TEST_OWNER_PROFILE_ID ?? "";
if (process.env.NODE_ENV !== "production" ||
    process.env.CASIMIR_PUBLIC_SITE_ONLY !== "1" ||
    process.env.CASIMIR_MANAGED_AI_PRIVATE_TEST !== "1" ||
    process.env.CASIMIR_MANAGED_AI_PRIVATE_DEVELOPER_TEXT_TEST !== "1" ||
    process.env.CASIMIR_MANAGED_AI_PRIVATE_DEVELOPER_PROVISION !== "1" ||
    !/^postgres(?:ql)?:\/\/\S+$/u.test(process.env.DATABASE_URL ?? "") ||
    !isManagedAiPrivateOwnerProfileId(ownerProfileId))
  throw new Error("Private developer provisioning is not explicitly configured");

await ensureDatabase();
const result = await provisionPrivateDeveloperManagedAiTerm({
  pool: getPool(), ownerProfileId,
});
console.log(JSON.stringify({
  state: result.newlyIssued ? "issued" : "already_issued",
  termId: result.termId, expiresAt: result.expiresAt,
}));
