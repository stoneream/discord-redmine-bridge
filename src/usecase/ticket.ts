import { randomUUID } from "node:crypto";
import { RedmineError, type RedmineClient, type RedmineProject } from "../redmine.ts";

export const MAX_SUBJECT_LENGTH = 255;

const FORM_LIFETIME_MS = 10 * 60 * 1000;
const MAX_OPEN_FORMS = 1000;
const MAX_CONCURRENT_CREATES = 10;

export type RedmineOperations = Pick<RedmineClient, "loadProjects" | "createIssue">;

interface FormOwner {
  userId: string;
  channelId: string | null;
}

interface OpenModal {
  nonce: string;
  triggerId: string;
  projectId: string;
  expiresAt: number;
}

interface FormSession extends FormOwner {
  projects: RedmineProject[];
  pickerExpiresAt: number;
  modal?: OpenModal;
  openingModal?: boolean;
}

export interface ProjectPage {
  index: number;
  pageCount: number;
  projects: RedmineProject[];
}

type OpenPickerResult =
  | { kind: "ready"; page: ProjectPage; discard: () => void }
  | { kind: "unavailable"; error: RedmineError }
  | { kind: "empty" }
  | { kind: "busy" };

type ProjectSelection =
  | { kind: "ready"; nonce: string; finish: (delivered: boolean) => void }
  | { kind: "invalid" }
  | { kind: "duplicate" }
  | { kind: "busy" };

type SubmissionResult =
  | { kind: "invalidForm" }
  | { kind: "invalidSubject" }
  | { kind: "busy" }
  | { kind: "created"; projectId: string; issue: Awaited<ReturnType<RedmineOperations["createIssue"]>> }
  | { kind: "rejected" | "uncertain"; projectId: string; subject: string; error: RedmineError };

export function createTicketUseCase(redmine: RedmineOperations, projectsPerPage: number) {
  const openForms = new Map<string, FormSession>();
  let pendingLoad: Promise<RedmineProject[]> | undefined;
  let createsInProgress = 0;

  function projectPage(projects: RedmineProject[], index: number): ProjectPage {
    const start = index * projectsPerPage;
    return {
      index,
      pageCount: Math.ceil(projects.length / projectsPerPage),
      projects: projects.slice(start, start + projectsPerPage),
    };
  }

  function findSession(id: string, owner: FormOwner) {
    const session = openForms.get(id);
    if (session?.userId === owner.userId && session.channelId === owner.channelId) return session;
  }

  function findPicker(id: string, owner: FormOwner) {
    const session = findSession(id, owner);
    if (session && session.pickerExpiresAt > Date.now()) return session;
  }

  async function openPicker(id: string, owner: FormOwner): Promise<OpenPickerResult> {
    let projects: RedmineProject[];
    try {
      pendingLoad ??= redmine.loadProjects().finally(() => {
        pendingLoad = undefined;
      });
      projects = await pendingLoad;
    } catch (error) {
      if (!(error instanceof RedmineError)) throw error;
      return { kind: "unavailable", error };
    }

    if (projects.length === 0) return { kind: "empty" };

    const now = Date.now();
    for (const [formId, session] of openForms) {
      if (session.pickerExpiresAt <= now && (session.modal?.expiresAt ?? 0) <= now) openForms.delete(formId);
    }
    if (openForms.size >= MAX_OPEN_FORMS || openForms.has(id)) return { kind: "busy" };

    const page = projectPage(projects, 0);
    const session: FormSession = { ...owner, projects, pickerExpiresAt: now + FORM_LIFETIME_MS };
    openForms.set(id, session);
    return {
      kind: "ready",
      page,
      discard() {
        if (openForms.get(id) === session) openForms.delete(id);
      },
    };
  }

  function getProjectPage(id: string, owner: FormOwner, index: number) {
    const session = findPicker(id, owner);
    if (!session || !Number.isSafeInteger(index) || index < 0 || index * projectsPerPage >= session.projects.length) {
      return;
    }
    return projectPage(session.projects, index);
  }

  function beginSelection(
    id: string,
    owner: FormOwner,
    triggerId: string,
    values: readonly string[],
  ): ProjectSelection {
    const session = findPicker(id, owner);
    const [projectId] = values;
    if (!session || values.length !== 1 || !session.projects.some((project) => project.id === projectId)) {
      return { kind: "invalid" };
    }
    if (session.modal?.triggerId === triggerId) return { kind: "duplicate" };
    if (session.openingModal) return { kind: "busy" };

    const nonce = randomUUID();
    const previousModal = session.modal;
    session.openingModal = true;
    session.modal = { nonce, triggerId, projectId, expiresAt: Date.now() + FORM_LIFETIME_MS };
    return {
      kind: "ready",
      nonce,
      finish(delivered) {
        if (!delivered) session.modal = previousModal;
        session.openingModal = false;
      },
    };
  }

  async function submitModal(
    id: string,
    owner: FormOwner,
    nonce: string,
    { readSubject, acknowledge }: { readSubject: () => string | undefined; acknowledge: () => Promise<unknown> },
  ): Promise<SubmissionResult> {
    const modal = findSession(id, owner)?.modal;
    if (!modal || modal.nonce !== nonce || modal.expiresAt <= Date.now()) return { kind: "invalidForm" };

    openForms.delete(id);
    const { projectId } = modal;
    const subject = readSubject()?.trim();
    if (!subject || [...subject].length > MAX_SUBJECT_LENGTH || /[\r\n]/.test(subject)) {
      return { kind: "invalidSubject" };
    }
    if (createsInProgress >= MAX_CONCURRENT_CREATES) return { kind: "busy" };

    createsInProgress += 1;
    try {
      await acknowledge();
      try {
        const issue = await redmine.createIssue(projectId, subject);
        return { kind: "created", projectId, issue };
      } catch (error) {
        if (!(error instanceof RedmineError)) throw error;
        const rejected = error.status === 401 || error.status === 403 || error.status === 404 || error.status === 422;
        return { kind: rejected ? "rejected" : "uncertain", projectId, subject, error };
      }
    } finally {
      createsInProgress -= 1;
    }
  }

  return { openPicker, getProjectPage, beginSelection, submitModal };
}
