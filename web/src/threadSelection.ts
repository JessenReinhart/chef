import type { UiThread } from "./threadApi";
import type { ChatMessage, MissionStatus, UiMission } from "./types";

export type ThreadHistoryLoad =
  | { current: true; messages: ChatMessage[] }
  | { current: false };

export type ThreadScopedRefreshResult<T> =
  | { current: true; value: T }
  | { current: false };

export type HomeThreadSelection = {
  activeThreads: UiThread[];
  archivedThreads: UiThread[];
  selectedThread: UiThread | null;
  readOnly: boolean;
};

type ThreadHistorySnapshot = {
  threadId: string;
  selectionGeneration: number;
  mutationGeneration: number;
};

const threadHistoryMutationGenerations = new Map<string, number>();
const activeThreadHistoryMutations = new Map<string, number>();

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

function threadHistoryMutationGeneration(threadId: string): number {
  return threadHistoryMutationGenerations.get(threadId) ?? 0;
}

/**
 * Keep the mutated Thread's history non-authoritative for the full conversation mutation window.
 * Reads for unrelated Threads remain usable when the user switches while a submission is slow.
 */
export function beginThreadHistoryMutation(threadId: string): () => void {
  activeThreadHistoryMutations.set(threadId, (activeThreadHistoryMutations.get(threadId) ?? 0) + 1);
  threadHistoryMutationGenerations.set(threadId, threadHistoryMutationGeneration(threadId) + 1);
  let ended = false;

  return () => {
    if (ended) return;
    ended = true;
    const remaining = (activeThreadHistoryMutations.get(threadId) ?? 1) - 1;
    if (remaining > 0) activeThreadHistoryMutations.set(threadId, remaining);
    else activeThreadHistoryMutations.delete(threadId);
    threadHistoryMutationGenerations.set(threadId, threadHistoryMutationGeneration(threadId) + 1);
  };
}

/**
 * Resolve an authoritative read only while the foreground Thread still owns it.
 * Slow state reads may settle after a Thread switch; those results are background
 * history, not valid Simple Mode foreground state.
 */
export async function loadForSelectedThread<T>(
  requestThreadId: string | null,
  selectedThreadId: () => string | null,
  load: () => Promise<T>,
): Promise<ThreadScopedRefreshResult<T>> {
  const value = await load();
  if (selectedThreadId() !== requestThreadId) return { current: false };
  return { current: true, value };
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
  let selectionGeneration = 0;

  function snapshot(threadId: string): ThreadHistorySnapshot {
    return {
      threadId,
      selectionGeneration,
      mutationGeneration: threadHistoryMutationGeneration(threadId),
    };
  }

  function isCurrent(candidate: ThreadHistorySnapshot): boolean {
    return !activeThreadHistoryMutations.has(candidate.threadId)
      && candidate.selectionGeneration === selectionGeneration
      && candidate.mutationGeneration === threadHistoryMutationGeneration(candidate.threadId);
  }

  return {
    snapshot,
    isCurrent,

    invalidate(): void {
      selectionGeneration += 1;
    },

    async load(threadId: string): Promise<ThreadHistoryLoad> {
      selectionGeneration += 1;
      const requestSnapshot = snapshot(threadId);
      try {
        const messages = await loadThreadMessages(threadId);
        if (!isCurrent(requestSnapshot)) return { current: false };
        return { current: true, messages };
      } catch (error) {
        if (!isCurrent(requestSnapshot)) return { current: false };
        throw error;
      }
    },
  };
}
