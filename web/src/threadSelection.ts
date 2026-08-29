import type { UiThread } from "./threadApi";
import type { ChatMessage, UiMission } from "./types";

export type ThreadHistoryLoad =
  | { current: true; messages: ChatMessage[] }
  | { current: false };

export type HomeThreadSelection = {
  activeThreads: UiThread[];
  archivedThreads: UiThread[];
  selectedThread: UiThread | null;
  readOnly: boolean;
};

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

export function missionsForSelectedThread(
  missions: readonly UiMission[],
  threadId: string | null,
): UiMission[] {
  if (!threadId) return [...missions];
  return missions.filter((mission) => mission.metadata?.threadId === threadId);
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
