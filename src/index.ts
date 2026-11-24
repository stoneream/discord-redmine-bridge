import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import { loadConfig } from "./config.ts";
import { command, createInteractionHandler } from "./interactions.ts";
import { logger, reportDiscordError } from "./logger.ts";
import { logMessages, ticketMessages } from "./message_const.ts";
import { RedmineClient } from "./redmine.ts";

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
    void handleInteraction(interaction).catch(async (error) => {
      reportDiscordError(logMessages.operationFailed, error, interaction);
      try {
        if (!interaction.isRepliable()) return;
        if (interaction.deferred) {
          const message = interaction.isModalSubmit()
            ? ticketMessages.resultUnavailable
            : ticketMessages.projectListUnavailable;
          await interaction.editReply(message);
        } else if (!interaction.replied) {
          await interaction.reply({
            content: ticketMessages.creationFailed,
            flags: MessageFlags.Ephemeral,
          });
        }
      } catch (replyError) {
        reportDiscordError(logMessages.replyFailed, replyError, interaction);
      }
    });
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
