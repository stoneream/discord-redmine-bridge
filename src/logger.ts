import pino from "pino";

export const logger = pino({
  timestamp: pino.stdTimeFunctions.isoTime,
});

export function redactLogText(text: string, ...sensitiveValues: (string | undefined)[]) {
  const values = [process.env.DISCORD_TOKEN, process.env.REDMINE_API_KEY, ...sensitiveValues]
    .flatMap((value) => (value?.trim() ? [value.trim()] : []))
    .sort((first, second) => second.length - first.length);
  let redacted = text;
  for (const value of values) {
    redacted = redacted.replaceAll(value, "");
  }
  return redacted.replace(/(\/(?:interactions|webhooks)\/\d+)\/[^/?#\s]*/gi, "$1");
}

export function reportDiscordError(message: string, error: unknown, interaction?: { id: string; token: string }) {
  function redact(text: unknown) {
    if (typeof text === "string") return redactLogText(text, interaction?.token);
  }

  const errorCode = error && typeof error === "object" && "code" in error ? error.code : undefined;
  let code: string | number | undefined;
  if (typeof errorCode === "number" && Number.isSafeInteger(errorCode)) code = errorCode;
  if (typeof errorCode === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(errorCode)) code = redact(errorCode);

  const details =
    error instanceof Error
      ? { name: redact(error.name), message: redact(error.message), stack: redact(error.stack) }
      : { message: redact(error) };
  logger.error({ interactionId: interaction?.id, code, error: details }, message);
}
