import type { UiThread } from "./threadApi";
import type { ChatMessage, MissionStatus, UiMission } from "./types";

export type ThreadHistoryLoad =
  | { current: true; messages: ChatMessage[] }
  | { current: false };

export type HomeThreadSelection = {
  activeThreads: UiThread[];
  archivedThreads: UiThread[];
  selectedThread: UiThread | null;
  readOnly: boolean;
};

export const NEW_THREAD_SUBMISSION_KEY = "__chef-new-thread-submission__";

export function threadSubmissionKey(threadId: string | null): string {
  return threadId ?? NEW_THREAD_SUBMISSION_KEY;
}

export function isThreadSubmissionPending(
  pending: ReadonlySet<string>,
  threadId: string | null,
): boolean {
  return pending.has(threadSubmissionKey(threadId));
}

export function setThreadSubmissionPending(
  pending: ReadonlySet<string>,
  key: string,
  isPending: boolean,
): Set<string> {
  const next = new Set(pending);
  if (isPending) next.add(key);
  else next.delete(key);
  return next;
}

export function moveThreadSubmissionPending(
  pending: ReadonlySet<string>,
  fromKey: string,
  toKey: string,
): Set<string> {
  const next = new Set(pending);
  next.delete(fromKey);
  next.add(toKey);
  return next;
}

export function resolveHomeThreadSelection(
  threads: readonly UiThread[],
  rememberedId: string | null,
): HomeThreadSelection {
  const activeThreads = threads.filter((thread) => thread.status === "active");
  const archivedThreads = threads.filter((thread) => thread.status === "archived");
  const remembered = rememberedId ? threads.find((thread) => thread.id === rememberedId) ?? null : null;
  const selectedThread = remembered ?? activeThreads[0] ?? null;

  return {
    activeThreads,
    archivedThreads,
    selectedThread,
    readOnly: selectedThread?.status === "archived",
  };
}

/** The resolved foreground Thread is the only valid target for new Simple Mode work. */
export function foregroundThreadId(selection: HomeThreadSelection): string | null {
  return selection.selectedThread?.id ?? null;
}

export function threadSubmissionOwnsForeground(
  submittedThreadId: string | null,
  selectedThreadId: string | null,
  transferredThreadId: string | null = null,
): boolean {
  if (submittedThreadId !== null) return submittedThreadId === selectedThreadId;
  if (transferredThreadId !== null) return transferredThreadId === selectedThreadId;
  return selectedThreadId === null;
}

export function missionsForSelectedThread(
  missions: readonly UiMission[],
  threadId: string | null,
): UiMission[] {
  if (!threadId) return [...missions];
  return missions.filter((mission) => mission.metadata?.threadId === threadId);
}

export function latestMissionForSelectedThread(
  missions: readonly UiMission[],
  threadId: string | null,
): UiMission | undefined {
  return [...missionsForSelectedThread(missions, threadId)].sort((a, b) =>
    b.createdAt - a.createdAt || b.updatedAt - a.updatedAt
  )[0];
}

export function missionStatusForSelectedThread(
  mission: UiMission | undefined,
  threadId: string | null,
  workspaceStatus: MissionStatus,
): MissionStatus {
  if (mission) return mission.status;
  return threadId ? "idle" : workspaceStatus;
}

export function latestAssistantThreadNote(
  messages: readonly ChatMessage[],
  missionId?: string,
): ChatMessage | null {
  return [...messages].reverse().find((message) => {
    if (message.role !== "assistant" || !message.content.trim()) return false;
    if (!missionId) return true;
    return message.metadata?.missionId === missionId;
  }) ?? null;
}

export function createThreadHistoryLoader(
  loadThreadMessages: (threadId: string) => Promise<ChatMessage[]>,
) {
  let generation = 0;

  return {
    snapshot(): number {
      return generation;
    },

    isCurrent(snapshot: number): boolean {
      return snapshot === generation;
    },

    invalidate(): void {
      generation += 1;
    },

    async load(threadId: string): Promise<ThreadHistoryLoad> {
      const requestGeneration = ++generation;
      try {
        const messages = await loadThreadMessages(threadId);
        if (requestGeneration !== generation) return { current: false };
        return { current: true, messages };
      } catch (error) {
        if (requestGeneration !== generation) return { current: false };
        throw error;
      }
    },
  };
}
