const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const PROJECT_PAGE_SIZE = 100;
const MAX_VALIDATION_ERRORS = 5;

export interface RedmineProject {
  id: string;
  name: string;
}

interface ProjectPage {
  offset?: number;
  total_count?: number;
  projects?: Array<{
    id?: number;
    name?: string;
    status?: number;
    enabled_modules?: Array<{ name?: string }>;
  }>;
}

export class RedmineError extends Error {
  readonly status?: number;
  readonly validationErrors?: readonly string[];

  constructor(message: string, status?: number, validationErrors?: readonly string[]) {
    super(message);
    this.status = status;
    this.validationErrors = validationErrors;
  }
}

function isPositiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.body) throw new RedmineError("Redmine の応答が空です。");

  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) throw new RedmineError("Redmine の応答が大きすぎます。");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
}

async function readValidationErrors(response: Response) {
  // A response that already returned 422 still confirms rejection if its details cannot be read.
  const data = await readJson(response).catch(() => undefined);
  if (!data || typeof data !== "object" || !("errors" in data) || !Array.isArray(data.errors)) return;

  const errors: string[] = [];
  for (const message of data.errors) {
    if (typeof message !== "string" || !message.trim()) continue;
    errors.push(message);
    if (errors.length === MAX_VALIDATION_ERRORS) break;
  }
  if (errors.length > 0) return errors;
}

export class RedmineClient {
  readonly #baseUrl: URL;
  readonly #apiKey: string;

  constructor(baseUrl: URL, apiKey: string) {
    this.#baseUrl = baseUrl;
    this.#apiKey = apiKey;
  }

  async loadProjects(): Promise<RedmineProject[]> {
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const projects = new Map<string, RedmineProject>();
    let offset = 0;
    let total: number | undefined;
    do {
      const path = `projects.json?include=enabled_modules&limit=${PROJECT_PAGE_SIZE}&offset=${offset}`;
      const page = (await this.#request(path, { signal })) as ProjectPage | null;
      total = page?.total_count;
      if (
        !Array.isArray(page?.projects) ||
        page.offset !== offset ||
        typeof total !== "number" ||
        !Number.isSafeInteger(total) ||
        total < 0 ||
        (offset < total && page.projects.length === 0)
      ) {
        throw new RedmineError("Redmine のプロジェクト一覧の応答が不正です。");
      }
      for (const project of page.projects) {
        if (
          !isPositiveId(project?.id) ||
          typeof project.name !== "string" ||
          !project.name.trim() ||
          project.status !== 1 ||
          !Array.isArray(project.enabled_modules) ||
          !project.enabled_modules.some((module) => module?.name === "issue_tracking")
        )
          continue;

        const id = String(project.id);
        projects.set(id, { id, name: project.name.trim() });
      }
      offset += page.projects.length;
    } while (offset < total);

    return [...projects.values()];
  }

  async createIssue(projectId: string, subject: string) {
    const data = (await this.#request("issues.json", {
      body: { issue: { project_id: Number(projectId), subject } },
    })) as { issue?: { id?: number } } | null;
    const id = data?.issue?.id;
    if (!isPositiveId(id)) {
      throw new RedmineError("Redmine の応答からチケットIDを確認できません。");
    }
    return { id, url: new URL(`issues/${id}`, this.#baseUrl).href };
  }

  async #request(
    path: string,
    { body, signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS) }: { body?: object; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const headers: Record<string, string> = { Accept: "application/json", "X-Redmine-API-Key": this.#apiKey };
    if (body) headers["Content-Type"] = "application/json";

    try {
      const response = await fetch(new URL(path, this.#baseUrl), {
        method: body ? "POST" : "GET",
        headers,
        body: body && JSON.stringify(body),
        redirect: "error",
        signal,
      });
      if (!response.ok) {
        const message = `Redmine が HTTP ${response.status} を返しました。`;
        if (body && response.status === 422) {
          throw new RedmineError(message, response.status, await readValidationErrors(response));
        }
        await response.body?.cancel().catch(() => undefined);
        throw new RedmineError(message, response.status);
      }

      return await readJson(response);
    } catch (error) {
      if (error instanceof RedmineError) throw error;
      throw new RedmineError("Redmine との通信に失敗した。もしくは、応答が不正です。");
    }
  }
}
