import { registerHelixDiscordCommands } from "../server/services/discord/discord-command-registry";

const applicationId = process.env.DISCORD_COMMAND_APPLICATION_ID?.trim() ||
  process.env.DISCORD_APPLICATION_ID?.trim() || "";
const botToken = process.env.DISCORD_BOT_TOKEN?.trim() || "";
const guildId = process.env.DISCORD_COMMAND_GUILD_ID?.trim() || null;

if (!/^\d{15,22}$/.test(applicationId) || !botToken ||
    (guildId && !/^\d{15,22}$/.test(guildId))) {
  console.error("Set DISCORD_COMMAND_APPLICATION_ID (or DISCORD_APPLICATION_ID), " +
    "DISCORD_BOT_TOKEN, and optionally DISCORD_COMMAND_GUILD_ID.");
  process.exitCode = 1;
} else {
  const result = await registerHelixDiscordCommands({ applicationId, botToken, guildId });
  console.log(JSON.stringify({ ok: result.ok, status: result.status,
    scope: guildId ? "guild" : "global", command: "helix" }));
  if (!result.ok) process.exitCode = 1;
}
