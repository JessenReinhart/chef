import { SELECTED_THREAD_EVENT } from "./threadApi.ts";

type ChatHistorySelectionEvents = Pick<EventTarget, "addEventListener" | "removeEventListener">;

/**
 * Keep rendered chat history owned by the foreground Simple Mode Thread.
 * Selection changes clear the old conversation synchronously, then only the newest
 * asynchronous history load may commit. This prevents a slow previous Thread read
 * from flashing back into the newly selected conversation.
 */
export function subscribeChatHistoryProjection<T>(
  loadHistory: () => Promise<T[]>,
  applyHistory: (history: T[]) => void,
  clearHistory: () => void,
  selectionEvents: ChatHistorySelectionEvents | null = typeof window !== "undefined" ? window : null,
): () => void {
  let closed = false;
  let selectionVersion = 0;

  const refresh = () => {
    if (closed) return;
    const refreshVersion = ++selectionVersion;
    clearHistory();
    void Promise.resolve()
      .then(loadHistory)
      .then((history) => {
        if (!closed && refreshVersion === selectionVersion) applyHistory(history);
      })
      .catch(() => undefined);
  };

  const handleThreadSelection = () => refresh();
  selectionEvents?.addEventListener(SELECTED_THREAD_EVENT, handleThreadSelection);
  refresh();

  return () => {
    closed = true;
    selectionVersion += 1;
    selectionEvents?.removeEventListener(SELECTED_THREAD_EVENT, handleThreadSelection);
  };
}
