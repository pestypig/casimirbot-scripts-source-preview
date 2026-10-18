import { pingMetricsEndpoint, runSmokeEval } from "../server/services/agi/eval-smoke";

async function main(): Promise<void> {
  const result = await runSmokeEval();
  console.log(JSON.stringify(result, null, 2));
  await pingMetricsEndpoint(process.env.EVAL_BASE_URL);
  if (!result.skipped && !(result.rate >= result.target)) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
