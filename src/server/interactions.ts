import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type ModalSubmitInteraction,
  type RepliableInteraction,
} from "discord.js";
import { logger, redactLogText, reportDiscordError } from "../logger.ts";
import { logMessages, TICKET_COMMAND_NAME, ticketMessages } from "../message_const.ts";
import {
  createTicketUseCase,
  MAX_SUBJECT_LENGTH,
  type ProjectPage,
  type RedmineOperations,
} from "../usecase/ticket.ts";

const SUBJECT_FIELD = "subject";
const MODAL_PREFIX = "redmine-issue:";
const PROJECT_PICKER_PREFIX = "redmine-project:";
const PROJECT_PAGE_PREFIX = "redmine-page:";
// Discord allows 40 components: a heading, up to 18 rows with one button each, and three for pagination.
const PROJECTS_PER_PAGE = 18;
const MAX_BUTTON_LABEL_LENGTH = 80;
const MAX_VALIDATION_MESSAGE_LENGTH = 256;

export const command = new SlashCommandBuilder()
  .setName(TICKET_COMMAND_NAME)
  .setDescription(ticketMessages.commandDescription);

function projectButton(pickerId: string, { id, name }: ProjectPage["projects"][number]) {
  const suffix = ` (#${id})`;
  const singleLine = name.replace(/\s+/gu, " ");
  const nameLimit = MAX_BUTTON_LABEL_LENGTH - suffix.length;
  const label =
    singleLine.length <= nameLimit
      ? singleLine
      : `${singleLine.slice(0, nameLimit - 1).replace(/[\uD800-\uDBFF]$/u, "")}…`;
  return new ButtonBuilder()
    .setCustomId(`${PROJECT_PICKER_PREFIX}${pickerId}:${id}`)
    .setStyle(ButtonStyle.Secondary)
    .setLabel(label + suffix);
}

function buildModal(customId: string) {
  const subjectInput = new TextInputBuilder()
    .setCustomId(SUBJECT_FIELD)
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(MAX_SUBJECT_LENGTH);

  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(ticketMessages.formTitle)
    .addLabelComponents(new LabelBuilder().setLabel(ticketMessages.subjectLabel).setTextInputComponent(subjectInput));
}

function projectPicker(id: string, { projects, index, pageCount }: ProjectPage) {
  const heading =
    pageCount === 1 ? ticketMessages.selectProject : ticketMessages.selectProjectPage(index + 1, pageCount);
  const components: (TextDisplayBuilder | ActionRowBuilder<ButtonBuilder>)[] = [
    new TextDisplayBuilder().setContent(heading),
    ...projects.map((project) => new ActionRowBuilder<ButtonBuilder>().addComponents(projectButton(id, project))),
  ];
  if (pageCount > 1) {
    const previous = new ButtonBuilder()
      .setCustomId(`${PROJECT_PAGE_PREFIX}${id}:${index - 1}`)
      .setStyle(ButtonStyle.Secondary)
      .setLabel(ticketMessages.previousPage)
      .setDisabled(index === 0);
    const next = new ButtonBuilder()
      .setCustomId(`${PROJECT_PAGE_PREFIX}${id}:${index + 1}`)
      .setStyle(ButtonStyle.Secondary)
      .setLabel(ticketMessages.nextPage)
      .setDisabled(index + 1 === pageCount);
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(previous, next));
  }
  return { flags: MessageFlags.IsComponentsV2 as const, components };
}

function projectListStatus(content: string) {
  return {
    flags: MessageFlags.IsComponentsV2 as const,
    components: [new TextDisplayBuilder().setContent(content)],
  };
}

function replyPrivately(interaction: RepliableInteraction, content: string) {
  return interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

function formOwner(interaction: RepliableInteraction) {
  return { userId: interaction.user.id, channelId: interaction.channelId };
}

export async function respondToInteractionError(interaction: Interaction, error: unknown) {
  reportDiscordError(logMessages.operationFailed, error, interaction);
  try {
    if (!interaction.isRepliable()) return;
    if (interaction.deferred) {
      await interaction.editReply(
        interaction.isModalSubmit()
          ? ticketMessages.resultUnavailable
          : projectListStatus(ticketMessages.projectListUnavailable),
      );
    } else if (!interaction.replied) {
      await replyPrivately(interaction, ticketMessages.creationFailed);
    }
  } catch (replyError) {
    reportDiscordError(logMessages.replyFailed, replyError, interaction);
  }
}

export function createInteractionHandler({ guildId, redmine }: { guildId: string; redmine: RedmineOperations }) {
  const tickets = createTicketUseCase(redmine, PROJECTS_PER_PAGE);

  async function selectProject(interaction: ButtonInteraction) {
    const [id, projectId, extra] = interaction.customId.slice(PROJECT_PICKER_PREFIX.length).split(":");
    if (!id || !projectId || extra !== undefined) return replyPrivately(interaction, ticketMessages.invalidForm);
    const selection = tickets.beginSelection(id, formOwner(interaction), interaction.id, projectId);
    if (selection.kind === "invalid") return replyPrivately(interaction, ticketMessages.invalidForm);
    if (selection.kind === "duplicate") return;
    if (selection.kind === "busy") return replyPrivately(interaction, ticketMessages.formBusy);

    const customId = `${MODAL_PREFIX}${id}:${selection.nonce}`;
    let delivered = false;
    try {
      await interaction.showModal(buildModal(customId));
      delivered = true;
    } finally {
      selection.finish(delivered);
    }
  }

  async function showProjectPicker(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const picker = await tickets.openPicker(interaction.id, formOwner(interaction));
    if (picker.kind === "unavailable") {
      const { error } = picker;
      logger.error(
        { interactionId: interaction.id, status: error.status, detail: error.message },
        logMessages.projectLoadFailed,
      );
      return interaction.editReply(projectListStatus(ticketMessages.projectListUnavailable));
    }

    if (picker.kind === "empty") return interaction.editReply(projectListStatus(ticketMessages.noProjects));
    if (picker.kind === "busy") return interaction.editReply(projectListStatus(ticketMessages.formBusy));
    try {
      await interaction.editReply(projectPicker(interaction.id, picker.page));
    } catch (error) {
      picker.discard();
      throw error;
    }
  }

  async function changeProjectPage(interaction: ButtonInteraction) {
    const [id, pageText] = interaction.customId.slice(PROJECT_PAGE_PREFIX.length).split(":");
    const page = tickets.getProjectPage(id, formOwner(interaction), Number(pageText));
    if (!page) return replyPrivately(interaction, ticketMessages.invalidForm);
    return interaction.update(projectPicker(id, page));
  }

  async function submitForm(interaction: ModalSubmitInteraction) {
    const [id, ...nonceParts] = interaction.customId.slice(MODAL_PREFIX.length).split(":");
    const result = await tickets.submitModal(id, formOwner(interaction), nonceParts.join(":"), {
      readSubject: () => interaction.fields.getTextInputValue(SUBJECT_FIELD),
      acknowledge: () => interaction.deferReply({ flags: MessageFlags.Ephemeral }),
    });
    if (result.kind === "invalidForm") return replyPrivately(interaction, ticketMessages.invalidForm);
    if (result.kind === "invalidSubject") {
      return replyPrivately(interaction, ticketMessages.invalidSubject(MAX_SUBJECT_LENGTH));
    }
    if (result.kind === "busy") return replyPrivately(interaction, ticketMessages.formBusy);

    const { projectId } = result;
    let content: string;
    if (result.kind === "created") {
      const { issue } = result;
      logger.info({ interactionId: interaction.id, projectId, issueId: issue.id }, logMessages.ticketCreated);
      content = ticketMessages.created(issue.id, issue.url);
    } else {
      const { error, subject } = result;
      const validationErrors = error.validationErrors?.map((message) =>
        redactLogText(message, subject, interaction.token)
          .trim()
          .slice(0, MAX_VALIDATION_MESSAGE_LENGTH)
          .replace(/[\uD800-\uDBFF]$/u, ""),
      );
      logger.error(
        {
          interactionId: interaction.id,
          projectId,
          status: error.status,
          detail: error.message,
          validationErrors,
        },
        logMessages.ticketCreationFailed,
      );
      content = result.kind === "rejected" ? ticketMessages.creationFailed : ticketMessages.creationUncertain;
    }

    await interaction.editReply({ content });
  }

  return async (interaction: Interaction) => {
    if (interaction.guildId !== guildId) return;

    if (interaction.isChatInputCommand() && interaction.commandName === command.name) {
      return showProjectPicker(interaction);
    }
    if (interaction.isButton()) {
      if (interaction.customId.startsWith(PROJECT_PICKER_PREFIX)) return selectProject(interaction);
      if (interaction.customId.startsWith(PROJECT_PAGE_PREFIX)) return changeProjectPage(interaction);
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith(MODAL_PREFIX)) {
      return submitForm(interaction);
    }
  };
}
