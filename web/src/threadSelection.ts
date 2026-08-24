import type { ChatMessage } from "./types";

export type ThreadHistoryLoad =
  | { current: true; messages: ChatMessage[] }
  | { current: false };

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
