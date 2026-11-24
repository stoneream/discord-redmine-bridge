function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} を設定してください。`);
  return value;
}

function readRedmineUrl() {
  const url = URL.parse(requireEnv("REDMINE_URL"));
  if (
    !url ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("REDMINE_URL に Redmine の HTTP または HTTPS のベース URL を設定してください。");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

export function loadConfig() {
  const token = requireEnv("DISCORD_TOKEN");
  const guildId = requireEnv("DISCORD_GUILD_ID");
  if (!/^\d{17,20}$/.test(guildId)) {
    throw new Error("DISCORD_GUILD_ID に Discord サーバーの ID を設定してください。");
  }

  return {
    token,
    guildId,
    redmineUrl: readRedmineUrl(),
    apiKey: requireEnv("REDMINE_API_KEY"),
  };
}
