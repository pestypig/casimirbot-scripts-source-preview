import pg from "pg";
import type { Pool as PgPool } from "pg";
import { migration126 } from "../server/db/migrations/126_managed_ai_reported_tokens";
import { migration127 } from "../server/db/migrations/127_managed_ai_checkout_claims";
import { migration128 } from "../server/db/migrations/128_managed_ai_checkout_requests";
import { migration129 } from "../server/db/migrations/129_managed_ai_term_subscriptions";
import { migration130 } from "../server/db/migrations/130_managed_ai_device_text_consent";
import { migration131 } from "../server/db/migrations/131_managed_ai_developer_terms";
import { provisionPrivateDeveloperManagedAiTerm } from
  "../server/services/helix-account/managed-ai-developer-provision";

// Run only with an operator's explicit fixture switch. Every object is scoped
// to this one PostgreSQL session's temporary schema; no real account or term
// is read, and process exit drops the fixture even if a test fails.
if (process.env.CASIMIR_MANAGED_AI_POSTGRES_FIXTURE !== "1" ||
    !/^postgres(?:ql)?:\/\/\S+$/u.test(process.env.DATABASE_URL ?? ""))
  throw new Error("Private managed AI PostgreSQL fixture is not configured");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
try {
  // Verify what unqualified CREATE TABLE means on this server before allowing
  // the real migration objects to run. A failed preflight rolls back even if
  // an unexpected server would place the probe in a durable schema.
  await client.query("BEGIN");
  try {
    await client.query("CREATE TEMP TABLE casimir_fixture_guard (id integer)");
    await client.query("SET LOCAL search_path TO pg_temp");
    await client.query("CREATE TABLE casimir_fixture_plain (id integer)");
    const probe = await client.query<{ relpersistence: string }>(`
      SELECT c.relpersistence FROM pg_class c
      WHERE c.relname = 'casimir_fixture_plain'
        AND c.relnamespace = pg_my_temp_schema();`);
    if (probe.rows.length !== 1 || probe.rows[0].relpersistence !== "t")
      throw new Error("PostgreSQL did not create an unqualified temporary table");
  } finally {
    await client.query("ROLLBACK");
  }

  await client.query("CREATE TEMP TABLE casimir_fixture_guard (id integer)");
  await client.query("SET search_path TO pg_temp");
  const schema = await client.query<{ schema_name: string }>(
    "SELECT current_schema() AS schema_name;");
  if (!schema.rows[0]?.schema_name.startsWith("pg_temp_"))
    throw new Error("PostgreSQL fixture is not in a temporary schema");

  await client.query(`CREATE TEMP TABLE helix_accounts (
    profile_id text PRIMARY KEY, deleted_at timestamptz);`);
  await client.query(`CREATE TEMP TABLE helix_account_linked_providers (
    profile_id text NOT NULL REFERENCES helix_accounts(profile_id),
    provider text NOT NULL, provider_subject text NOT NULL);`);
  await client.query(`CREATE TEMP TABLE helix_managed_ai_terms (
    term_id text PRIMARY KEY,
    profile_id text NOT NULL REFERENCES helix_accounts(profile_id),
    source_kind text NOT NULL CONSTRAINT helix_managed_ai_terms_source_kind_check
      CHECK (source_kind IN ('subscription', 'trial')),
    source_ref text NOT NULL, offer_revision text NOT NULL,
    status text NOT NULL, period_starts_at timestamptz NOT NULL,
    period_ends_at timestamptz NOT NULL,
    budget_micros bigint NOT NULL,
    committed_micros bigint NOT NULL DEFAULT 0,
    UNIQUE (profile_id, source_kind, source_ref));`);
  await client.query(`CREATE TEMP TABLE helix_managed_ai_seller_budget (
    budget_id text PRIMARY KEY, status text NOT NULL,
    period_starts_at timestamptz NOT NULL,
    period_ends_at timestamptz NOT NULL,
    budget_micros bigint NOT NULL,
    committed_micros bigint NOT NULL DEFAULT 0);`);
  await client.query("CREATE TEMP TABLE helix_managed_ai_requests (request_id text PRIMARY KEY)");
  await client.query("CREATE TEMP TABLE helix_managed_ai_device_links (request_id text PRIMARY KEY)");
  await client.query("CREATE TEMP TABLE helix_managed_ai_device_grants (grant_id text PRIMARY KEY)");

  const migrations = [migration126, migration127, migration128,
    migration129, migration130, migration131];
  for (const migration of migrations)
    await migration.run(client, { enablePgvector: false });
  const created = await client.query<{ relname: string; relpersistence: string }>(`
    SELECT c.relname, c.relpersistence FROM pg_class c
    WHERE c.relnamespace = pg_my_temp_schema() AND c.relkind = 'r';`);
  const expected = ["helix_managed_ai_checkout_intents",
    "helix_managed_ai_subscription_claims", "helix_managed_ai_checkout_requests",
    "helix_managed_ai_term_subscriptions"];
  if (expected.some(name => !created.rows.some(row =>
    row.relname === name && row.relpersistence === "t")) ||
      created.rows.some(row => row.relpersistence !== "t"))
    throw new Error("A managed AI migration escaped the temporary schema");

  const profileId = "fixture-owner-0001";
  await client.query("INSERT INTO helix_accounts (profile_id) VALUES ($1)", [profileId]);
  await client.query(`INSERT INTO helix_account_linked_providers
    (profile_id, provider, provider_subject) VALUES ($1,'auth0','fixture-subject')`,
  [profileId]);
  // The provisioner controls its own BEGIN/COMMIT. Return this same client
  // with a no-op release so both calls can see the session's temp tables.
  const fixturePool = { connect: async () => ({
    query: client.query.bind(client), release: () => undefined,
  }) } as unknown as PgPool;
  const first = await provisionPrivateDeveloperManagedAiTerm({ pool: fixturePool,
    ownerProfileId: profileId });
  await client.query(`UPDATE helix_managed_ai_terms SET committed_micros = 17
    WHERE term_id = $1`, [first.termId]);
  const second = await provisionPrivateDeveloperManagedAiTerm({ pool: fixturePool,
    ownerProfileId: profileId });
  const result = await client.query<{ term_count: string; committed_micros: string }>(`
    SELECT count(*)::text AS term_count,
      max(committed_micros)::text AS committed_micros
    FROM helix_managed_ai_terms WHERE profile_id = $1;`, [profileId]);
  if (!first.newlyIssued || second.newlyIssued || first.termId !== second.termId ||
      result.rows[0]?.term_count !== "1" ||
      result.rows[0]?.committed_micros !== "17")
    throw new Error("Private developer provisioner reset or duplicated the term");

  console.log(JSON.stringify({ postgres_fixture: "pass",
    migration_ids: migrations.map(migration => migration.id),
    provisioner: "issued_once_without_reset", temp_table_count: created.rows.length }));
} finally {
  await client.query("DISCARD TEMP").catch(() => undefined);
  await client.query("RESET search_path").catch(() => undefined);
  client.release();
  await pool.end();
}
