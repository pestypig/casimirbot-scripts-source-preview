import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveHelixAskConversationalReferent } from "../server/services/helix-ask/referent-resolution";
import { runAskLevelTheoryContextReflectionTool } from "../server/services/helix-ask/theory-context-reflection-tool";

type JsonRecord = Record<string, unknown>;

type ParityScenario = {
  id: string;
  question: string;
  prior_assistant_answer: string;
  source_ref: string;
  expected: {
    referent_source_kind: string;
    referent_confidence: string;
    required_exact_badge_ids?: string[];
    required_likely_badge_ids?: string[];
    forbidden_exact_badge_ids?: string[];
    minimum_represented_probability_mass?: number;
  };
  non_affirmative_variants: string[];
};

type ParityFixture = {
  schema: "helix.replit_parity_fixture.v1";
  scenarios: ParityScenario[];
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = path.join(repoRoot, "scripts", "fixtures", "helix-replit-parity.v1.json");

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  const record = value as JsonRecord;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, stableValue(record[key])]),
  );
};

const sha256 = (value: string | Buffer): string =>
  `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;

const fixtureBody = (scenario: ParityScenario, question = scenario.question): JsonRecord => ({
  question,
  workspace_context_snapshot: {
    chat_referent_context: {
      schema: "helix.ask.chat_referent_context.v1",
      previous_assistant_final_answer: {
        role: "assistant",
        source_ref: scenario.source_ref,
        reply_id: `reply:${scenario.id}`,
        text: scenario.prior_assistant_answer,
      },
    },
  },
});

const assert = (condition: unknown, message: string): asserts condition => {
  if (!condition) throw new Error(message);
};

export const evaluateHelixReplitParityFixture = async () => {
  const fixtureBytes = await fs.readFile(fixturePath);
  const fixture = JSON.parse(fixtureBytes.toString("utf8")) as ParityFixture;
  assert(fixture.schema === "helix.replit_parity_fixture.v1", "Parity fixture schema is invalid.");
  assert(fixture.scenarios.length > 0, "Parity fixture has no scenarios.");

  const scenarios = fixture.scenarios.map((scenario) => {
    const resolution = resolveHelixAskConversationalReferent(fixtureBody(scenario));
    assert(
      resolution.trace.resolution_confidence === "high" && resolution.resolvedText,
      `${scenario.id}: affirmative referent did not bind with high confidence`,
    );
    assert(
      resolution.trace.source_kind === scenario.expected.referent_source_kind,
      `${scenario.id}: referent source kind differs from the fixture contract`,
    );
    assert(
      resolution.trace.resolution_confidence === scenario.expected.referent_confidence,
      `${scenario.id}: referent confidence differs from the fixture contract`,
    );
    assert(
      resolution.resolvedText === scenario.prior_assistant_answer,
      `${scenario.id}: bound referent text differs from the fixture answer`,
    );
    assert(
      resolution.trace.resolved_source_ref === scenario.source_ref,
      `${scenario.id}: referent source ref differs from the fixture`,
    );

    for (const prompt of scenario.non_affirmative_variants) {
      const variant = resolveHelixAskConversationalReferent(fixtureBody(scenario, prompt));
      assert(
        variant.trace.referent_detected === false,
        `${scenario.id}: non-affirmative variant admitted execution: ${prompt}`,
      );
    }

    const receipt = runAskLevelTheoryContextReflectionTool({
      prompt: resolution.resolvedText,
      conversationContext: scenario.question,
      turnId: `parity-static:${scenario.id}`,
      threadId: "helix-replit-parity-static",
      buildExplanationPlan: true,
      syncPanel: false,
      openPanel: false,
    });
    const exactBadgeIds = [...receipt.reflectionV1.overlay.exactBadgeIds].sort();
    const likelyBadgeIds = [...receipt.reflectionV1.overlay.likelyBadgeIds].sort();
    for (const requiredBadgeId of scenario.expected.required_exact_badge_ids ?? []) {
      assert(
        exactBadgeIds.includes(requiredBadgeId),
        `${scenario.id}: required exact badge is missing: ${requiredBadgeId}`,
      );
    }
    for (const requiredBadgeId of scenario.expected.required_likely_badge_ids ?? []) {
      assert(
        likelyBadgeIds.includes(requiredBadgeId),
        `${scenario.id}: required likely badge is missing: ${requiredBadgeId}`,
      );
    }
    for (const forbiddenBadgeId of scenario.expected.forbidden_exact_badge_ids ?? []) {
      assert(
        !exactBadgeIds.includes(forbiddenBadgeId),
        `${scenario.id}: contextual badge was incorrectly promoted to exact: ${forbiddenBadgeId}`,
      );
    }
    const uncertainty = receipt.reflectionV1.overlay.uncertainty;
    const representedProbabilityMass = uncertainty?.representedProbabilityMass ?? null;
    if (scenario.expected.minimum_represented_probability_mass !== undefined) {
      assert(
        representedProbabilityMass !== null &&
          representedProbabilityMass >= scenario.expected.minimum_represented_probability_mass,
        `${scenario.id}: represented probability mass is below the fixture minimum`,
      );
    }
    return {
      id: scenario.id,
      question_sha256: sha256(scenario.question),
      referent_source_ref: resolution.trace.resolved_source_ref,
      referent_text_hash: resolution.trace.resolved_text_hash,
      semantic_prompt_sha256: sha256(resolution.resolvedText),
      exact_badge_ids: exactBadgeIds,
      likely_badge_ids: likelyBadgeIds,
      represented_probability_mass: representedProbabilityMass,
      out_of_graph_probability: uncertainty?.outOfGraphProbability ?? null,
      graph_id: receipt.reflectionV1.graphId,
    };
  });

  const contract = {
    schema: "helix.replit_parity_static_result.v1",
    fixture_sha256: sha256(fixtureBytes),
    scenarios,
  };
  return {
    ...contract,
    parity_contract_sha256: sha256(JSON.stringify(stableValue(contract))),
  };
};

const main = async () => {
  const result = await evaluateHelixReplitParityFixture();
  const outArgument = process.argv.find((argument) => argument.startsWith("--out="));
  if (outArgument) {
    const outputPath = path.resolve(repoRoot, outArgument.slice("--out=".length));
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  console.log(
    `[replit] static parity verified: scenarios=${result.scenarios.length} contract=${result.parity_contract_sha256}`,
  );
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[replit] static parity failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
