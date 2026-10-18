import fs from "node:fs";
import { setDiscordSolarSubscription } from "../server/services/discord/discord-solar-subscriptions";

type SourceRow = { guild_id?: unknown; channel_id?: unknown; guildId?: unknown; channelId?: unknown };

const path = process.argv[2];
const applicationId = (process.env.DISCORD_SOLAR_APPLICATION_ID || "").trim();
if (!path || !/^\d{15,22}$/.test(applicationId)) {
  throw new Error("Pass the old solar_update_channels JSON file and set DISCORD_SOLAR_APPLICATION_ID.");
}
const parsed: unknown = JSON.parse(fs.readFileSync(path, "utf8"));
if (!Array.isArray(parsed)) throw new Error("Expected an array of old solar_update_channels rows.");
const rows = (parsed as SourceRow[]).map((row, index) => {
  const guildId = String(row.guild_id ?? row.guildId ?? "").trim();
  const channelId = String(row.channel_id ?? row.channelId ?? "").trim();
  if (!/^\d{15,22}$/.test(guildId) || !/^\d{15,22}$/.test(channelId)) {
    throw new Error(`Source row ${index + 1} has invalid Discord IDs; import stopped.`);
  }
  return { guildId, channelId };
});
let imported = 0;
for (const row of rows) {
  await setDiscordSolarSubscription({
    application_id: applicationId,
    guild_id: row.guildId,
    channel_id: row.channelId,
    enabled: true,
  });
  imported += 1;
}
console.log(JSON.stringify({ ok: true, imported, application_id: applicationId }));
