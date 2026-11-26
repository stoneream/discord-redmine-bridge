export const TICKET_COMMAND_NAME = "ticket";

const ticketCommand = `\`/${TICKET_COMMAND_NAME}\``;
const contactAdmin = "サーバーの管理者にお問い合わせください。";
const contactAdminIfPersistent = `同じ問題が続く場合は、${contactAdmin}`;
const reopenForm = `${ticketCommand} を実行し、再度お試しください。`;
const checkRedmine = `Redmine でチケットが作成されていることを確認してください。確認できない場合は、${contactAdmin}`;

export const ticketMessages = {
  commandDescription: "チケットを作成します",
  formTitle: "チケットの作成",
  subjectLabel: "チケット名",
  previousPage: "前へ",
  nextPage: "次へ",
  selectProject: "起票するプロジェクトを選択してください。",
  selectProjectPage: (page: number, pageCount: number) =>
    `起票するプロジェクトを選択してください（${page}/${pageCount} ページ）。`,
  projectListUnavailable: `プロジェクト一覧を表示できませんでした。${contactAdmin}`,
  noProjects: `選択できるプロジェクトが存在しません。${contactAdmin}`,
  invalidForm: `このフォームは使用できません。${reopenForm}${contactAdminIfPersistent}`,
  formBusy: `チケットの作成が混み合っています。時間をおいてから ${ticketCommand} を実行しお試しください。${contactAdminIfPersistent}`,
  invalidSubject: (maxLength: number) =>
    `${ticketCommand} を実行し、チケット名を 1〜${maxLength} 文字で入力してください。`,
  created: (id: number, url: string) => `チケット #${id} を作成しました。\n<${url}>`,
  creationFailed: `チケットの作成に失敗しました。${contactAdmin}`,
  creationUncertain: `チケットの作成に失敗した可能性があります。${checkRedmine}`,
  resultUnavailable: `チケット作成の結果を表示できませんでした。${checkRedmine}`,
};

export const logMessages = {
  configLoaded: "起動設定を読み込みました。",
  configLoadFailed: "設定の読み込みに失敗しました。",
  operationFailed: "チケット作成中に問題が発生しました。",
  replyFailed: "結果を表示できませんでした。",
  discordError: "Discord Bot の動作中に問題が発生しました。",
  ready: `/${TICKET_COMMAND_NAME} の受付を開始しました。`,
  registrationFailed: `Discord サーバーに /${TICKET_COMMAND_NAME} を登録できませんでした。Bot の追加先と DISCORD_GUILD_ID の設定を確認してください。`,
  connectionFailed: "Discord に接続できませんでした。Bot トークンとネットワーク接続を確認してください。",
  projectLoadFailed: "プロジェクト取得に失敗しました。",
  ticketCreated: "チケットを作成しました。",
  ticketCreationFailed: "チケットの作成に失敗しました。",
};
