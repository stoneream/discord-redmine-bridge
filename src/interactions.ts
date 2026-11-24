import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type ModalSubmitInteraction,
  type RepliableInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { logger, redactLogText } from "./logger.ts";
import { logMessages, TICKET_COMMAND_NAME, ticketMessages } from "./message_const.ts";
import { RedmineError, type RedmineClient, type RedmineProject } from "./redmine.ts";

const SUBJECT_FIELD = "subject";
const MODAL_PREFIX = "redmine-issue:";
const PROJECT_PICKER_PREFIX = "redmine-project:";
const PROJECT_PAGE_PREFIX = "redmine-page:";
const MAX_CHOICES = 25;
const MAX_SUBJECT_LENGTH = 255;
const FORM_LIFETIME_MS = 10 * 60 * 1000;
const MAX_OPEN_FORMS = 1000;
const MAX_CONCURRENT_CREATES = 10;
const MAX_VALIDATION_MESSAGE_LENGTH = 256;

interface OpenModal {
  customId: string;
  triggerId: string;
  projectId: string;
  expiresAt: number;
}

interface FormSession {
  userId: string;
  channelId: string | null;
  projects: RedmineProject[];
  pickerExpiresAt: number;
  modal?: OpenModal;
  openingModal?: boolean;
}

export const command = new SlashCommandBuilder()
  .setName(TICKET_COMMAND_NAME)
  .setDescription(ticketMessages.commandDescription);

function projectOption({ id, name }: RedmineProject) {
  const suffix = ` (#${id})`;
  const label = name.slice(0, 100 - suffix.length).replace(/[\uD800-\uDBFF]$/u, "") + suffix;
  return { label, value: id };
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

function projectPicker(id: string, projects: RedmineProject[], page: number) {
  const pageCount = Math.ceil(projects.length / MAX_CHOICES);
  const start = page * MAX_CHOICES;
  const select = new StringSelectMenuBuilder()
    .setCustomId(PROJECT_PICKER_PREFIX + id)
    .setPlaceholder(ticketMessages.projectLabel)
    .addOptions(projects.slice(start, start + MAX_CHOICES).map(projectOption));
  const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  if (pageCount === 1) return { content: ticketMessages.selectProject, components: [selectRow] };

  const previous = new ButtonBuilder()
    .setCustomId(`${PROJECT_PAGE_PREFIX}${id}:${page - 1}`)
    .setStyle(ButtonStyle.Secondary)
    .setLabel(ticketMessages.previousPage)
    .setDisabled(page === 0);
  const next = new ButtonBuilder()
    .setCustomId(`${PROJECT_PAGE_PREFIX}${id}:${page + 1}`)
    .setStyle(ButtonStyle.Secondary)
    .setLabel(ticketMessages.nextPage)
    .setDisabled(page + 1 === pageCount);
  return {
    content: ticketMessages.selectProjectPage(page + 1, pageCount),
    components: [selectRow, new ActionRowBuilder<ButtonBuilder>().addComponents(previous, next)],
  };
}

function replyPrivately(interaction: RepliableInteraction, content: string) {
  return interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

function createFailureMessage(error: RedmineError) {
  if (error.status === 401 || error.status === 403 || error.status === 404 || error.status === 422) {
    return ticketMessages.creationFailed;
  }
  return ticketMessages.creationUncertain;
}

export function createInteractionHandler({
  guildId,
  redmine,
}: {
  guildId: string;
  redmine: Pick<RedmineClient, "loadProjects" | "createIssue">;
}) {
  const openForms = new Map<string, FormSession>();
  let createsInProgress = 0;
  let pendingLoad: Promise<RedmineProject[]> | undefined;

  function rememberSession(interaction: ChatInputCommandInteraction, projects: RedmineProject[]) {
    const now = Date.now();
    for (const [id, session] of openForms) {
      if (session.pickerExpiresAt <= now && (session.modal?.expiresAt ?? 0) <= now) openForms.delete(id);
    }
    if (openForms.size >= MAX_OPEN_FORMS || openForms.has(interaction.id)) return;

    const session: FormSession = {
      userId: interaction.user.id,
      channelId: interaction.channelId,
      projects,
      pickerExpiresAt: now + FORM_LIFETIME_MS,
    };
    openForms.set(interaction.id, session);
    return session;
  }

  function findSession(interaction: RepliableInteraction, id: string) {
    const session = openForms.get(id);
    if (session?.userId === interaction.user.id && session.channelId === interaction.channelId) return session;
  }

  function findPicker(interaction: RepliableInteraction, id: string) {
    const session = findSession(interaction, id);
    if (session && session.pickerExpiresAt > Date.now()) return session;
  }

  function takeModal(interaction: ModalSubmitInteraction) {
    const [id] = interaction.customId.slice(MODAL_PREFIX.length).split(":");
    const session = findSession(interaction, id);
    const modal = session?.modal;
    if (modal?.customId === interaction.customId && modal.expiresAt > Date.now()) {
      openForms.delete(id);
      return modal;
    }
  }

  async function selectProject(interaction: StringSelectMenuInteraction) {
    const id = interaction.customId.slice(PROJECT_PICKER_PREFIX.length);
    const session = findPicker(interaction, id);
    const [projectId] = interaction.values;
    if (!session || interaction.values.length !== 1 || !session.projects.some((project) => project.id === projectId)) {
      return replyPrivately(interaction, ticketMessages.invalidForm);
    }
    if (session.modal?.triggerId === interaction.id) return;
    if (session.openingModal) return replyPrivately(interaction, ticketMessages.formBusy);

    const customId = `${MODAL_PREFIX}${id}:${randomUUID()}`;
    const previousModal = session.modal;
    session.openingModal = true;
    session.modal = { customId, triggerId: interaction.id, projectId, expiresAt: Date.now() + FORM_LIFETIME_MS };
    try {
      await interaction.showModal(buildModal(customId));
    } catch (error) {
      session.modal = previousModal;
      throw error;
    } finally {
      session.openingModal = false;
    }
  }

  async function showProjectPicker(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let projects: RedmineProject[];
    try {
      pendingLoad ??= redmine.loadProjects().finally(() => {
        pendingLoad = undefined;
      });
      projects = await pendingLoad;
    } catch (error) {
      if (!(error instanceof RedmineError)) throw error;
      logger.error(
        { interactionId: interaction.id, status: error.status, detail: error.message },
        logMessages.projectLoadFailed,
      );
      return interaction.editReply({ content: ticketMessages.projectListUnavailable });
    }

    if (projects.length === 0) {
      return interaction.editReply({ content: ticketMessages.noProjects });
    }
    const session = rememberSession(interaction, projects);
    if (!session) return interaction.editReply({ content: ticketMessages.formBusy });
    try {
      await interaction.editReply(projectPicker(interaction.id, projects, 0));
    } catch (error) {
      if (openForms.get(interaction.id) === session) openForms.delete(interaction.id);
      throw error;
    }
  }

  async function changeProjectPage(interaction: ButtonInteraction) {
    const [id, pageText] = interaction.customId.slice(PROJECT_PAGE_PREFIX.length).split(":");
    const page = Number(pageText);
    const session = findPicker(interaction, id);
    if (!session || !Number.isSafeInteger(page) || page < 0 || page * MAX_CHOICES >= session.projects.length) {
      return replyPrivately(interaction, ticketMessages.invalidForm);
    }
    return interaction.update(projectPicker(id, session.projects, page));
  }

  async function submitForm(interaction: ModalSubmitInteraction) {
    const modal = takeModal(interaction);
    if (!modal) return replyPrivately(interaction, ticketMessages.invalidForm);

    const { projectId } = modal;
    const subject = interaction.fields.getTextInputValue(SUBJECT_FIELD)?.trim();
    if (!subject || [...subject].length > MAX_SUBJECT_LENGTH || /[\r\n]/.test(subject)) {
      return replyPrivately(interaction, ticketMessages.invalidSubject(MAX_SUBJECT_LENGTH));
    }
    if (createsInProgress >= MAX_CONCURRENT_CREATES) {
      return replyPrivately(interaction, ticketMessages.formBusy);
    }

    let content: string;
    createsInProgress += 1;
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const issue = await redmine.createIssue(projectId, subject);
        logger.info({ interactionId: interaction.id, projectId, issueId: issue.id }, logMessages.ticketCreated);
        content = ticketMessages.created(issue.id, issue.url);
      } catch (error) {
        if (!(error instanceof RedmineError)) throw error;
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
        content = createFailureMessage(error);
      }
    } finally {
      createsInProgress -= 1;
    }

    await interaction.editReply({ content });
  }

  return async (interaction: Interaction) => {
    if (interaction.guildId !== guildId) return;

    if (interaction.isChatInputCommand() && interaction.commandName === command.name) {
      return showProjectPicker(interaction);
    }
    if (interaction.isButton() && interaction.customId.startsWith(PROJECT_PAGE_PREFIX)) {
      return changeProjectPage(interaction);
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith(PROJECT_PICKER_PREFIX)) {
      return selectProject(interaction);
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith(MODAL_PREFIX)) {
      return submitForm(interaction);
    }
  };
}
