import { Client, Events, GatewayIntentBits } from "discord.js";
import { loadConfig } from "./config.ts";
import { logger, reportDiscordError } from "./logger.ts";
import { logMessages } from "./message_const.ts";
import { RedmineClient } from "./redmine.ts";
import { command, createInteractionHandler, respondToInteractionError } from "./server/interactions.ts";

const SECRET_PREFIX_LENGTH = 5;

function maskSecret(secret: string) {
  const characters = [...secret];
  const visibleLength = characters.length > SECRET_PREFIX_LENGTH ? SECRET_PREFIX_LENGTH : 0;
  const prefix = characters.slice(0, visibleLength).join("");
  return prefix + "*".repeat(characters.length - visibleLength);
}

async function start() {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (error) {
    logger.error(error instanceof Error ? error.message : logMessages.configLoadFailed);
    process.exitCode = 1;
    return;
  }

  logger.info(
    {
      DISCORD_TOKEN: maskSecret(config.token),
      DISCORD_GUILD_ID: config.guildId,
      REDMINE_URL: config.redmineUrl.href,
      REDMINE_API_KEY: maskSecret(config.apiKey),
    },
    logMessages.configLoaded,
  );

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    allowedMentions: { parse: [] },
  });
  const redmine = new RedmineClient(config.redmineUrl, config.apiKey);
  const handleInteraction = createInteractionHandler({ guildId: config.guildId, redmine });

  client.on(Events.InteractionCreate, (interaction) => {
    void handleInteraction(interaction).catch((error) => respondToInteractionError(interaction, error));
  });

  client.on(Events.Error, (error) => reportDiscordError(logMessages.discordError, error));
  client.once(Events.ClientReady, async (readyClient) => {
    try {
      await readyClient.application.commands.create(command, config.guildId);
      logger.info({ guildId: config.guildId }, logMessages.ready);
    } catch (error) {
      reportDiscordError(logMessages.registrationFailed, error);
      await readyClient.destroy();
      process.exitCode = 1;
    }
  });

  try {
    await client.login(config.token);
  } catch (error) {
    reportDiscordError(logMessages.connectionFailed, error);
    process.exitCode = 1;
  }
}

await start();
