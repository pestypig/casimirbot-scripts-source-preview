import { CAMPAIGN_USAGE, runCampaignCli } from './warp-full-solve-campaign.js';

runCampaignCli()
  .then((payload) => {
    console.log(JSON.stringify(payload, null, 2));
    process.exitCode = 0;
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    if (message.includes('Invalid --wave value') || message.includes('Invalid --seed value') || message.includes('Invalid --wave-timeout-ms value') || message.includes('Invalid --campaign-timeout-ms value')) {
      console.error(CAMPAIGN_USAGE);
    }
    process.exitCode = 1;
  })
  .finally(() => {
    setImmediate(() => process.exit(process.exitCode ?? 0));
  });
