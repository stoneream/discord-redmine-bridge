import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mock, test } from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  Client,
  ComponentType,
  Events,
  MessageFlags,
  type Interaction,
  type InteractionEditReplyOptions,
  type InteractionReplyOptions,
  type InteractionUpdateOptions,
  type ModalBuilder,
} from "discord.js";
import { logger } from "../src/logger.ts";
import { ticketMessages } from "../src/message_const.ts";
import { RedmineClient, RedmineError, type RedmineProject } from "../src/redmine.ts";
import { command, createInteractionHandler } from "../src/server/interactions.ts";
import { createTicketUseCase } from "../src/usecase/ticket.ts";

const guildId = "123456789012345678";
const baseUrl = new URL("https://redmine.example.test/work/");

test("accepts a Redmine base URL over HTTP or HTTPS", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import assert from "node:assert/strict";
       import { loadConfig } from "./src/config.ts";
       for (const protocol of ["http", "https"]) {
         const baseUrl = protocol + "://redmine.example.test/work";
         process.env.REDMINE_URL = baseUrl;
         assert.equal(loadConfig().redmineUrl.href, baseUrl + "/");
       }
       process.env.REDMINE_URL = "ftp://redmine.example.test/work";
       assert.throws(loadConfig, /HTTP または HTTPS/);`,
    ],
    {
      cwd: new URL("../", import.meta.url),
      env: { DISCORD_TOKEN: "test-token", DISCORD_GUILD_ID: guildId, REDMINE_API_KEY: "test-key" },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
});

test("logs the masked Discord token and Redmine API key with the startup configuration", async (t) => {
  const env = {
    DISCORD_TOKEN: process.env.DISCORD_TOKEN,
    DISCORD_GUILD_ID: process.env.DISCORD_GUILD_ID,
    REDMINE_URL: process.env.REDMINE_URL,
    REDMINE_API_KEY: process.env.REDMINE_API_KEY,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const events: string[] = [];
  const info = t.mock.method(logger, "info", () => events.push("config"));
  t.mock.method(Client.prototype, "login", async function (this: Client) {
    events.push("login");
    await this.destroy();
    return "test-login";
  });

  process.env.DISCORD_TOKEN = " test-token ";
  process.env.DISCORD_GUILD_ID = guildId;
  process.env.REDMINE_URL = "https://redmine.example.test/work";
  process.env.REDMINE_API_KEY = "key34-private";
  const entry = new URL("../src/index.ts?startup-test", import.meta.url);
  await import(entry.href);

  assert.deepEqual(info.mock.calls[0].arguments, [
    {
      DISCORD_TOKEN: "test-*****",
      DISCORD_GUILD_ID: guildId,
      REDMINE_URL: baseUrl.href,
      REDMINE_API_KEY: "key34********",
    },
    "起動設定を読み込みました。",
  ]);
  assert.deepEqual(events, ["config", "login"]);
});

test("defines /ticket without command options", () => {
  const { name, options } = command.toJSON();
  assert.equal(name, "ticket");
  assert.deepEqual(options, []);
});

test("logs Discord error details with credentials redacted", () => {
  const logged = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { reportDiscordError } from "./src/logger.ts";
     const error = Object.assign(
       new Error("Unknown interaction: bot-test-secret, redmine-test-secret, interaction-test-secret, /webhooks/12345/route-test-secret/messages/@original"),
       { code: 10062, requestBody: { content: "request-body-test-secret" } },
     );
     reportDiscordError("operation failed", error, { id: "test-interaction", token: "interaction-test-secret" });`,
    ],
    {
      cwd: new URL("../", import.meta.url),
      env: { DISCORD_TOKEN: "bot-test-secret", REDMINE_API_KEY: "redmine-test-secret" },
      encoding: "utf8",
    },
  );
  assert.equal(logged.status, 0, logged.stderr);
  const entry = JSON.parse(logged.stdout);
  assert.equal(entry.level, 50);
  assert.equal(entry.msg, "operation failed");
  assert.equal(entry.interactionId, "test-interaction");
  assert.equal(entry.code, 10062);
  assert.equal(entry.error.name, "Error");
  assert.equal(entry.error.message, "Unknown interaction: , , , /webhooks/12345/messages/@original");
  assert.match(entry.error.stack, /\n\s+at /);
  assert.doesNotMatch(logged.stdout, /test-secret|requestBody/);
});

function discordInteraction(kind: "command" | "button" | "modal", id: string) {
  const interaction = {
    id,
    guildId,
    channelId: "channel",
    user: { id: "owner" },
    token: "test-interaction-token",
    commandName: "ticket",
    customId: "",
    deferred: false,
    fields: { getTextInputValue: () => "" },
    isChatInputCommand: () => kind === "command",
    isButton: () => kind === "button",
    isModalSubmit: () => kind === "modal",
    isRepliable: () => true,
    showModal: mock.fn(async (modal: ModalBuilder) => modal.toJSON()),
    reply: mock.fn(async (response: InteractionReplyOptions) => response),
    editReply: mock.fn(async (response: InteractionEditReplyOptions) => response),
    update: mock.fn(async (response: InteractionUpdateOptions) => response),
    deferReply: mock.fn(async ({ flags }: InteractionReplyOptions) => {
      assert.equal(flags, MessageFlags.Ephemeral);
      interaction.deferred = true;
    }),
  };
  return Object.assign(interaction, { asDiscordEvent: () => interaction as unknown as Interaction });
}

function modalSubmission(id: string, customId: string, subject = "起票テスト") {
  const submit = discordInteraction("modal", id);
  submit.customId = customId;
  submit.fields = { getTextInputValue: () => subject };
  return submit;
}

function messageComponent(response: InteractionEditReplyOptions | InteractionUpdateOptions, index: number) {
  const component = response.components?.at(index);
  assert.ok(component && "toJSON" in component);
  return component.toJSON();
}

function pageButtons(response: InteractionEditReplyOptions | InteractionUpdateOptions) {
  const data = messageComponent(response, -1);
  assert.equal(data.type, ComponentType.ActionRow);
  return data.components;
}

function projectList(response: InteractionEditReplyOptions | InteractionUpdateOptions, paginated = false) {
  assert.equal(response.flags, MessageFlags.IsComponentsV2);
  const heading = messageComponent(response, 0);
  assert.equal(heading.type, ComponentType.TextDisplay);
  const buttons = response.components?.slice(1, paginated ? -1 : undefined).map((_, index) => {
    const row = messageComponent(response, index + 1);
    assert.equal(row.type, ComponentType.ActionRow);
    assert.equal(row.components.length, 1);
    const [button] = row.components;
    assert.ok(button.type === ComponentType.Button && "custom_id" in button);
    return button;
  });
  assert.ok(buttons);
  return { heading: heading.content, buttons };
}

function buttonPress(id: string, customId: string) {
  const press = discordInteraction("button", id);
  press.customId = customId;
  return press;
}

async function openProjectPicker(handle: (interaction: Interaction) => Promise<unknown>, id: string) {
  const command = discordInteraction("command", id);
  await handle(command.asDiscordEvent());
  return projectList(command.editReply.mock.calls[0].arguments[0]).buttons;
}

async function openTicketModal(handle: (interaction: Interaction) => Promise<unknown>, id = "open-ticket") {
  const [project] = await openProjectPicker(handle, id);
  const select = buttonPress(`${id}-select`, project.custom_id);
  await handle(select.asDiscordEvent());
  const modal = await select.showModal.mock.calls[0].result;
  assert.ok(modal);
  return modal;
}

test("replies through the entry point when Discord cannot display a picker or a creation result", async (t) => {
  t.mock.property(process, "env", {
    ...process.env,
    DISCORD_TOKEN: "test-token",
    DISCORD_GUILD_ID: guildId,
    REDMINE_URL: baseUrl.href,
    REDMINE_API_KEY: "test-key",
  });
  t.mock.method(logger, "info", () => {});
  t.mock.method(logger, "error", () => {});
  const login = t.mock.method(Client.prototype, "login", async () => "test-login");
  t.mock.method(RedmineClient.prototype, "loadProjects", async () => [{ id: "1", name: "プロジェクト" }]);
  const createIssue = t.mock.method(RedmineClient.prototype, "createIssue", async () => ({
    id: 81,
    url: new URL("issues/81", baseUrl).href,
  }));

  await import(new URL("../src/index.ts?interaction-error-test", import.meta.url).href);
  const client = login.mock.calls[0]?.this;
  assert.ok(client instanceof Client);
  t.after(() => client.destroy());

  const dispatch = async (interaction: Interaction) => {
    client.emit(Events.InteractionCreate, interaction);
    // The listener schedules its replies through promises, with all external calls mocked.
    await setImmediate();
  };

  const command = discordInteraction("command", "failed-picker");
  command.editReply.mock.mockImplementationOnce(async () => {
    throw new Error("Discord could not display the picker");
  });
  await dispatch(command.asDiscordEvent());
  const fallback = command.editReply.mock.calls[1].arguments[0];
  assert.equal(fallback.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(messageComponent(fallback, 0), {
    type: ComponentType.TextDisplay,
    content: ticketMessages.projectListUnavailable,
  });

  const modal = await openTicketModal(dispatch);
  const submit = modalSubmission("failed-result", modal.custom_id);
  submit.editReply.mock.mockImplementationOnce(async () => {
    throw new Error("Discord could not display the creation result");
  });
  await dispatch(submit.asDiscordEvent());
  assert.equal(createIssue.mock.callCount(), 1);
  assert.deepEqual(submit.editReply.mock.calls[1]?.arguments, [ticketMessages.resultUnavailable]);
});

test("fetches fresh project pages on command and submits a modal exactly once", async (t) => {
  const infoLog = t.mock.method(logger, "info", () => {});
  let listingCount = 0;
  const createPayloads: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (url: URL, options: RequestInit) => {
    assert.equal(url.origin, baseUrl.origin);
    assert.equal(new Headers(options.headers).get("X-Redmine-API-Key"), "test-key");
    assert.equal(options.redirect, "error");
    if (url.pathname === "/work/issues.json") {
      assert.equal(options.method, "POST");
      createPayloads.push(JSON.parse(String(options.body)));
      return Response.json({ issue: { id: 81 } }, { status: 201 });
    }
    assert.equal(url.pathname, "/work/projects.json");
    assert.equal(url.searchParams.get("include"), "enabled_modules");
    const offset = Number(url.searchParams.get("offset"));
    const enabledModules = [{ name: "issue_tracking" }];
    if (offset === 0) {
      listingCount += 1;
      return Response.json({
        offset,
        total_count: 3,
        projects: [
          { id: 1, name: `プロジェクト ${listingCount}`, status: 1, enabled_modules: enabledModules },
          { id: 2, name: "アーカイブ済み", status: 9, enabled_modules: enabledModules },
        ],
      });
    }
    assert.equal(offset, 2);
    return Response.json({
      offset,
      total_count: 3,
      projects: [{ id: 3, name: "チケットなし", status: 1, enabled_modules: [] }],
    });
  });

  const redmine = new RedmineClient(baseUrl, "test-key");
  const handle = createInteractionHandler({ guildId, redmine });
  assert.equal(listingCount, 0);
  await handle(discordInteraction("command", "open-1").asDiscordEvent());
  const open = discordInteraction("command", "open-2");
  await handle(open.asDiscordEvent());
  assert.equal(listingCount, 2);

  const listing = open.editReply.mock.calls[0].arguments[0];
  assert.equal(listing.components?.length, 2);
  const { buttons } = projectList(listing);
  assert.deepEqual(
    buttons.map(({ label }) => label),
    ["プロジェクト 2 (#1)"],
  );
  const [project] = buttons;

  const select = buttonPress("select-project", project.custom_id);
  await handle(select.asDiscordEvent());
  const modal = await select.showModal.mock.calls[0].result;
  assert.ok(modal);
  const { custom_id: customId, components } = modal;
  assert.equal(components.length, 1);
  const [subject] = components;
  assert.ok("component" in subject && subject.component.type === ComponentType.TextInput);
  assert.partialDeepStrictEqual(subject.component, { required: true, min_length: 1, max_length: 255 });
  const submit = modalSubmission("submit", customId, " 起票テスト ");

  submit.user.id = "another-user";
  await handle(submit.asDiscordEvent());
  assert.equal(createPayloads.length, 0);
  submit.user.id = "owner";
  const replay = modalSubmission("replay", customId);
  await Promise.all([handle(submit.asDiscordEvent()), handle(replay.asDiscordEvent())]);
  assert.deepEqual(createPayloads, [{ issue: { project_id: 1, subject: "起票テスト" } }]);
  assert.equal(infoLog.mock.callCount(), 1);
  assert.deepEqual(infoLog.mock.calls[0].arguments, [
    { interactionId: "submit", projectId: "1", issueId: 81 },
    "チケットを作成しました。",
  ]);
  assert.match(submit.editReply.mock.calls.at(-1)?.arguments[0].content ?? "", /example\.test\/work\/issues\/81/);
  const replayReply = replay.reply.mock.calls[0].arguments[0].content ?? "";
  assert.match(replayReply, /`\/ticket`/);
  assert.match(replayReply, /管理者にお問い合わせください。/);
});

test("acknowledges commands before loading projects and keeps modal and picker lifetimes separate", async (t) => {
  t.mock.method(logger, "info", () => {});
  t.mock.timers.enable({ apis: ["Date"] });
  const load = Promise.withResolvers<RedmineProject[]>();
  const loadProjects = mock.fn(() => load.promise);
  const createIssue = mock.fn(async () => ({ id: 81, url: new URL("issues/81", baseUrl).href }));
  const handle = createInteractionHandler({
    guildId,
    redmine: {
      loadProjects,
      createIssue,
    },
  });
  const command = discordInteraction("command", "first");
  const secondCommand = discordInteraction("command", "second");
  const opening = Promise.all([handle(command.asDiscordEvent()), handle(secondCommand.asDiscordEvent())]);
  assert.equal(command.deferReply.mock.callCount(), 1);
  assert.equal(secondCommand.deferReply.mock.callCount(), 1);
  assert.equal(loadProjects.mock.callCount(), 0);
  await Promise.resolve();
  assert.equal(loadProjects.mock.callCount(), 1);
  assert.equal(command.editReply.mock.callCount(), 0);
  load.resolve([{ id: "1", name: "プロジェクト" }]);
  await opening;

  const [project] = projectList(command.editReply.mock.calls[0].arguments[0]).buttons;

  const selection = buttonPress("open-modal", project.custom_id);
  await handle(selection.asDiscordEvent());
  assert.equal(selection.showModal.mock.callCount(), 1);

  t.mock.timers.tick(9 * 60_000);
  const failedSelection = buttonPress("failed-open", project.custom_id);
  failedSelection.showModal.mock.mockImplementationOnce(async () => {
    throw new Error("Discord could not display the modal");
  });
  await assert.rejects(handle(failedSelection.asDiscordEvent()), /could not display/);

  const reopenedSelection = buttonPress("reopened-modal", project.custom_id);
  const showing = Promise.withResolvers<void>();
  reopenedSelection.showModal.mock.mockImplementationOnce(async (modal) => {
    await showing.promise;
    return modal.toJSON();
  });
  const reopening = handle(reopenedSelection.asDiscordEvent());
  const concurrent = buttonPress("concurrent-selection", project.custom_id);
  await handle(concurrent.asDiscordEvent());
  assert.equal(concurrent.showModal.mock.callCount(), 0);
  assert.match(concurrent.reply.mock.calls[0].arguments[0].content ?? "", /混み合っています/);
  showing.resolve();
  await reopening;
  const modal = await reopenedSelection.showModal.mock.calls[0].result;
  assert.ok(modal);

  t.mock.timers.tick(60_000);
  const expiredPicker = buttonPress("expired-picker", project.custom_id);
  await handle(expiredPicker.asDiscordEvent());
  assert.match(expiredPicker.reply.mock.calls[0].arguments[0].content ?? "", /このフォームは使用できません/);
  await handle(modalSubmission("submit-reopened", modal.custom_id).asDiscordEvent());
  assert.equal(createIssue.mock.callCount(), 1);
});

test("discards a picker session when Discord cannot display it", async () => {
  const handle = createInteractionHandler({
    guildId,
    redmine: {
      loadProjects: async () => [{ id: "1", name: "プロジェクト" }],
      createIssue: async () => assert.fail("Opening a picker must not create an issue"),
    },
  });
  const command = discordInteraction("command", "open-ticket");
  command.editReply.mock.mockImplementationOnce(async () => {
    throw new Error("Discord could not display the picker");
  });
  await assert.rejects(handle(command.asDiscordEvent()), /could not display the picker/);

  const [project] = await openProjectPicker(handle, command.id);
  assert.equal(project.label, "プロジェクト (#1)");
});

test("restores the previous modal when Discord cannot display its replacement", async (t) => {
  t.mock.method(logger, "info", () => {});
  const createIssue = mock.fn(async (_projectId: string, _subject: string) => ({
    id: 81,
    url: new URL("issues/81", baseUrl).href,
  }));
  const handle = createInteractionHandler({
    guildId,
    redmine: {
      loadProjects: async () => [
        { id: "1", name: "プロジェクト 1" },
        { id: "2", name: "プロジェクト 2" },
      ],
      createIssue,
    },
  });
  const [firstProject, secondProject] = await openProjectPicker(handle, "open-ticket");
  const original = buttonPress("original-selection", firstProject.custom_id);
  await handle(original.asDiscordEvent());
  const originalModal = await original.showModal.mock.calls[0].result;
  assert.ok(originalModal);

  const replacement = buttonPress("replacement-selection", secondProject.custom_id);
  replacement.showModal.mock.mockImplementationOnce(async () => {
    throw new Error("Discord could not display the modal");
  });
  await assert.rejects(handle(replacement.asDiscordEvent()), /could not display the modal/);
  const failedModal = replacement.showModal.mock.calls[0].arguments[0].toJSON();
  await handle(modalSubmission("failed-modal", failedModal.custom_id).asDiscordEvent());
  assert.equal(createIssue.mock.callCount(), 0);

  await handle(modalSubmission("restore-original", originalModal.custom_id).asDiscordEvent());
  assert.deepEqual(
    createIssue.mock.calls.map(({ arguments: args }) => args),
    [["1", "起票テスト"]],
  );
});

test("releases a creation slot if Discord cannot acknowledge the submission", async (t) => {
  t.mock.method(logger, "info", () => {});
  const pendingIssue = Promise.withResolvers<{ id: number; url: string }>();
  const createIssue = mock.fn(() => pendingIssue.promise);
  const handle = createInteractionHandler({
    guildId,
    redmine: { loadProjects: async () => [{ id: "1", name: "プロジェクト" }], createIssue },
  });
  const submissions = await Promise.all(
    Array.from({ length: 12 }, async (_, index) => {
      const modal = await openTicketModal(handle, `open-ticket-${index}`);
      return modalSubmission(`submit-${index}`, modal.custom_id);
    }),
  );
  const [failed, busy, replacement, ...others] = submissions;
  const inProgress = others.map((submission) => handle(submission.asDiscordEvent()));
  const acknowledgement = Promise.withResolvers<void>();
  failed.deferReply.mock.mockImplementationOnce(() => acknowledgement.promise);
  const failure = assert.rejects(handle(failed.asDiscordEvent()), /could not acknowledge/);

  await handle(busy.asDiscordEvent());
  assert.equal(busy.deferReply.mock.callCount(), 0);
  assert.match(busy.reply.mock.calls[0].arguments[0].content ?? "", /混み合っています/);
  assert.equal(createIssue.mock.callCount(), 9);

  acknowledgement.reject(new Error("Discord could not acknowledge the submission"));
  await failure;
  assert.equal(createIssue.mock.callCount(), 9);

  const saving = handle(replacement.asDiscordEvent());
  await Promise.resolve();
  assert.equal(createIssue.mock.callCount(), 10);
  pendingIssue.resolve({ id: 81, url: new URL("issues/81", baseUrl).href });
  await Promise.all([...inProgress, saving]);
});

test("consumes a modal once even while its acknowledgement is pending", async () => {
  const issue = { id: 81, url: new URL("issues/81", baseUrl).href };
  const createIssue = mock.fn(async (_projectId: string, _subject: string) => issue);
  const tickets = createTicketUseCase(
    {
      loadProjects: async () => [{ id: "1", name: "プロジェクト" }],
      createIssue,
    },
    25,
  );
  const owner = { userId: "owner", channelId: "channel" };
  const picker = await tickets.openPicker("picker", owner);
  assert.equal(picker.kind, "ready");
  const selection = tickets.beginSelection("picker", owner, "select", "1");
  assert.equal(selection.kind, "ready");
  selection.finish(true);

  const pendingAcknowledgement = Promise.withResolvers<void>();
  const form = {
    readSubject: mock.fn(() => " 起票テスト "),
    acknowledge: mock.fn(() => pendingAcknowledgement.promise),
  };
  const submit = () => tickets.submitModal("picker", owner, selection.nonce, form);
  const first = submit();
  assert.equal(createIssue.mock.callCount(), 0);
  assert.deepEqual(await submit(), { kind: "invalidForm" });
  pendingAcknowledgement.resolve();
  assert.deepEqual(await first, { kind: "created", projectId: "1", issue });
  assert.deepEqual(await submit(), { kind: "invalidForm" });

  assert.equal(form.readSubject.mock.callCount(), 1);
  assert.equal(form.acknowledge.mock.callCount(), 1);
  assert.deepEqual(
    createIssue.mock.calls.map(({ arguments: args }) => args),
    [["1", "起票テスト"]],
  );
});

test("explains what to do when ticket creation is rejected or cannot be confirmed", async (t) => {
  t.mock.method(logger, "error", () => {});
  const request = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Redmine could not be reached");
  });
  request.mock.mockImplementationOnce(async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.error(new Error("The response body was interrupted"));
      },
    });
    return new Response(body, { status: 403 });
  });
  const client = new RedmineClient(baseUrl, "test-key");
  const expectedReplies = [
    /チケットの作成に失敗しました。/,
    /Redmine でチケットが作成されていることを確認してください。/,
  ];
  for (const expected of expectedReplies) {
    const handle = createInteractionHandler({
      guildId,
      redmine: {
        loadProjects: async () => [{ id: "1", name: "プロジェクト" }],
        createIssue: client.createIssue.bind(client),
      },
    });
    const modal = await openTicketModal(handle);
    const submit = modalSubmission("submit-form", modal.custom_id, "テスト");
    await handle(submit.asDiscordEvent());
    const reply = submit.editReply.mock.calls[0].arguments[0].content ?? "";
    assert.match(reply, expected);
    assert.match(reply, /サーバーの管理者にお問い合わせください。/);
  }
});

test("places 18 projects in individual rows on one page and opens the selected project", async (t) => {
  t.mock.method(logger, "info", () => {});
  const projects = Array.from({ length: 18 }, (_, index) => ({
    id: String(Number.MAX_SAFE_INTEGER - index),
    name: `チーム ${index + 1}\n${"😀".repeat(100)}`,
  }));
  const createIssue = mock.fn(async (_projectId: string, _subject: string) => ({
    id: 81,
    url: new URL("issues/81", baseUrl).href,
  }));
  const handle = createInteractionHandler({
    guildId,
    redmine: { loadProjects: async () => projects, createIssue },
  });
  const open = discordInteraction("command", "full-page");
  await handle(open.asDiscordEvent());

  const listing = open.editReply.mock.calls[0].arguments[0];
  assert.equal(listing.components?.length, 19);
  const { buttons } = projectList(listing);
  assert.equal(new Set(buttons.map((button) => button.custom_id)).size, projects.length);
  for (const [index, button] of buttons.entries()) {
    const label = button.label ?? "";
    assert.ok(label.length <= 80);
    assert.equal(label, label.toWellFormed());
    assert.doesNotMatch(label, /\n/);
    assert.ok(label.endsWith(`… (#${projects[index].id})`));
  }

  const select = buttonPress("select-last-project", buttons[17].custom_id);
  select.user.id = "another-user";
  await handle(select.asDiscordEvent());
  assert.equal(select.showModal.mock.callCount(), 0);
  select.user.id = "owner";
  await handle(select.asDiscordEvent());
  const modal = await select.showModal.mock.calls[0].result;
  assert.ok(modal);
  await handle(modalSubmission("submit-for-last-project", modal.custom_id).asDiscordEvent());
  assert.deepEqual(createIssue.mock.calls[0].arguments, [projects[17].id, "起票テスト"]);
});

test("reopens a modal from the project picker and accepts only the latest submission once", async (t) => {
  t.mock.method(logger, "info", () => {});
  const projects = Array.from({ length: 25 }, (_, index) => ({
    id: String(index + 1),
    name: `チーム ${index + 1}`,
  }));
  const createIssue = mock.fn(async (_projectId: string, _subject: string) => ({
    id: 81,
    url: new URL("issues/81", baseUrl).href,
  }));
  const handle = createInteractionHandler({
    guildId,
    redmine: {
      loadProjects: async () => projects,
      createIssue,
    },
  });
  const open = discordInteraction("command", "many-projects");
  await handle(open.asDiscordEvent());
  const reply = open.editReply.mock.calls[0].arguments[0];
  const firstPage = projectList(reply, true);
  assert.match(firstPage.heading, /1\/2/);
  assert.equal(firstPage.buttons.length, 18);
  assert.equal(firstPage.buttons[0].label, "チーム 1 (#1)");
  assert.equal(firstPage.buttons[17].label, "チーム 18 (#18)");
  const [firstPrevious, next] = pageButtons(reply);
  assert.ok(firstPrevious.type === ComponentType.Button && firstPrevious.disabled);
  assert.ok(next.type === ComponentType.Button && "custom_id" in next);
  assert.equal(next.disabled, false);
  // Count the heading, project rows and buttons, and navigation row and buttons.
  assert.equal(1 + firstPage.buttons.length * 2 + 3, 40);

  const page = buttonPress("next-page", next.custom_id);
  page.user.id = "another-user";
  await handle(page.asDiscordEvent());
  assert.equal(page.update.mock.callCount(), 0);
  page.user.id = "owner";
  await handle(page.asDiscordEvent());
  const update = page.update.mock.calls[0].arguments[0];
  const secondPage = projectList(update, true);
  assert.match(secondPage.heading, /2\/2/);
  assert.equal(secondPage.buttons.length, 7);
  assert.equal(secondPage.buttons[0].label, "チーム 19 (#19)");
  const lastProject = secondPage.buttons[6];
  assert.equal(lastProject.label, "チーム 25 (#25)");
  const invalidSelection = buttonPress("unlisted-project", lastProject.custom_id.replace(/:25$/, ":26"));
  await handle(invalidSelection.asDiscordEvent());
  assert.equal(invalidSelection.showModal.mock.callCount(), 0);
  assert.match(invalidSelection.reply.mock.calls[0].arguments[0].content ?? "", /このフォームは使用できません/);

  const select = buttonPress("select-project", lastProject.custom_id);
  await handle(select.asDiscordEvent());
  const modal = await select.showModal.mock.calls[0].result;
  assert.ok(modal);

  const [previous, lastNext] = pageButtons(update);
  assert.ok(previous.type === ComponentType.Button && "custom_id" in previous);
  assert.equal(previous.disabled, false);
  assert.ok(lastNext.type === ComponentType.Button && lastNext.disabled);
  const back = buttonPress("previous-page", previous.custom_id);
  await handle(back.asDiscordEvent());
  assert.match(projectList(back.update.mock.calls[0].arguments[0], true).heading, /1\/2/);

  const newSelect = buttonPress("select-another-project", firstPage.buttons[0].custom_id);
  await handle(newSelect.asDiscordEvent());
  const newModal = await newSelect.showModal.mock.calls[0].result;
  assert.ok(newModal);
  assert.notEqual(newModal.custom_id, modal.custom_id);

  const duplicatedSelection = buttonPress(select.id, select.customId);
  duplicatedSelection.showModal.mock.mockImplementationOnce(async () => {
    throw new Error("Discord already acknowledged this interaction");
  });
  const duplicate = assert.rejects(handle(duplicatedSelection.asDiscordEvent()), /already acknowledged/);
  const stale = modalSubmission("old-modal", modal.custom_id);
  await handle(stale.asDiscordEvent());
  assert.match(stale.reply.mock.calls[0].arguments[0].content ?? "", /このフォームは使用できません/);
  await duplicate;
  const wrongChannel = modalSubmission("wrong-channel", newModal.custom_id);
  wrongChannel.channelId = "other-channel";
  await handle(wrongChannel.asDiscordEvent());
  assert.match(wrongChannel.reply.mock.calls[0].arguments[0].content ?? "", /このフォームは使用できません/);
  assert.equal(createIssue.mock.callCount(), 0);

  const submit = modalSubmission("valid-modal", newModal.custom_id);
  const replay = modalSubmission("replayed-modal", newModal.custom_id);
  await Promise.all([handle(submit.asDiscordEvent()), handle(replay.asDiscordEvent())]);
  assert.deepEqual(
    createIssue.mock.calls.map(({ arguments: args }) => args),
    [["1", "起票テスト"]],
  );
  assert.match(replay.reply.mock.calls[0].arguments[0].content ?? "", /このフォームは使用できません/);
});

test("rejects an expired modal before contacting Redmine", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const createIssue = mock.fn(async () => assert.fail("An expired modal must not create an issue"));
  const handle = createInteractionHandler({
    guildId,
    redmine: { loadProjects: async () => [{ id: "1", name: "プロジェクト" }], createIssue },
  });
  const modal = await openTicketModal(handle);

  t.mock.timers.tick(10 * 60_000);
  const expired = modalSubmission("expired-modal", modal.custom_id);
  await handle(expired.asDiscordEvent());
  assert.match(expired.reply.mock.calls[0].arguments[0].content ?? "", /このフォームは使用できません/);
  assert.equal(createIssue.mock.callCount(), 0);
});

test("logs bounded and redacted validation messages while keeping the Discord response generic", async (t) => {
  const apiKey = "redmine-test-secret";
  const botToken = "discord-test-secret";
  const subject = "非公開のチケット名";
  const originalApiKey = process.env.REDMINE_API_KEY;
  const originalBotToken = process.env.DISCORD_TOKEN;
  process.env.REDMINE_API_KEY = apiKey;
  process.env.DISCORD_TOKEN = botToken;
  t.after(() => {
    if (originalApiKey === undefined) delete process.env.REDMINE_API_KEY;
    else process.env.REDMINE_API_KEY = originalApiKey;
    if (originalBotToken === undefined) delete process.env.DISCORD_TOKEN;
    else process.env.DISCORD_TOKEN = originalBotToken;
  });

  const customFieldError = "A required custom field is missing";
  const longMessage = `${"x".repeat(252)}${apiKey}tail-more`;
  const errorLog = t.mock.method(logger, "error", () => {});
  const request = t.mock.method(globalThis, "fetch", async (url: URL, options: RequestInit) => {
    assert.equal(url.pathname, "/work/issues.json");
    assert.equal(options.method, "POST");
    return Response.json(
      {
        errors: [
          customFieldError,
          null,
          `Rejected ${apiKey}, ${botToken}, ${subject}, test-interaction-token`,
          longMessage,
          "Fourth error",
          "Fifth error",
          "Sixth error",
        ],
      },
      { status: 422 },
    );
  });
  const client = new RedmineClient(baseUrl, apiKey);
  const handle = createInteractionHandler({
    guildId,
    redmine: {
      loadProjects: async () => [{ id: "1", name: "プロジェクト" }],
      createIssue: client.createIssue.bind(client),
    },
  });
  const modal = await openTicketModal(handle);
  const submit = modalSubmission("submit-validation", modal.custom_id, subject);
  await handle(submit.asDiscordEvent());

  assert.equal(request.mock.callCount(), 1);
  assert.equal(errorLog.mock.callCount(), 1);
  assert.partialDeepStrictEqual(errorLog.mock.calls[0].arguments[0], {
    interactionId: "submit-validation",
    projectId: "1",
    status: 422,
    validationErrors: [customFieldError, "Rejected , , ,", `${"x".repeat(252)}tail`, "Fourth error", "Fifth error"],
  });
  const reply = submit.editReply.mock.calls[0].arguments[0].content ?? "";
  assert.match(reply, /チケットの作成に失敗しました。.*管理者にお問い合わせください。/);
  assert.ok(!reply.includes(customFieldError));
});

test("preserves a rejected status when the validation body cannot be read", async (t) => {
  const responses = [
    new Response(null, { status: 422 }),
    new Response("malformed", { status: 422 }),
    Response.json({ errors: [null, "", { message: "Unexpected" }] }, { status: 422 }),
    Response.json({ errors: ["x".repeat(4 * 1024 * 1024)] }, { status: 422 }),
  ];
  const request = t.mock.method(globalThis, "fetch", async () => {
    const response = responses.shift();
    assert.ok(response);
    return response;
  });
  const client = new RedmineClient(baseUrl, "test-key");
  while (responses.length > 0) {
    await assert.rejects(
      client.createIssue("1", "入力"),
      (error) => error instanceof RedmineError && error.status === 422 && error.validationErrors === undefined,
    );
  }
  assert.equal(request.mock.callCount(), 4);

  const timeout = new AbortController();
  t.mock.method(AbortSignal, "timeout", () => timeout.signal);
  request.mock.mockImplementationOnce(async (_url?: URL, options?: RequestInit) => {
    assert.equal(options?.signal, timeout.signal);
    return new Response(
      new ReadableStream({
        start(controller) {
          timeout.signal.addEventListener("abort", () => controller.error(timeout.signal.reason), { once: true });
        },
      }),
      { status: 422 },
    );
  });
  const submission = client.createIssue("1", "入力");
  timeout.abort(new DOMException("Timeout", "TimeoutError"));
  await assert.rejects(
    submission,
    (error) => error instanceof RedmineError && error.status === 422 && error.validationErrors === undefined,
  );
  assert.equal(request.mock.callCount(), 5);
});
