import { SELECTED_THREAD_EVENT } from "./threadApi.ts";

type ThreadSelectionEvents = Pick<EventTarget, "addEventListener" | "removeEventListener">;

export interface ChatSubmissionOwnership {
  begin(): number;
  isCurrent(token: number): boolean;
  dispose(): void;
}

/**
 * Own in-flight ChatPanel submissions by the currently selected Simple Mode Thread.
 * A Thread switch invalidates the previous submission immediately, so late network
 * settlement cannot mutate the newly selected conversation or release a newer send.
 */
export function createChatSubmissionOwnership(
  onThreadSelection: () => void,
  selectionEvents: ThreadSelectionEvents | null = typeof window !== "undefined" ? window : null,
): ChatSubmissionOwnership {
  let closed = false;
  let version = 0;

  const handleThreadSelection = () => {
    if (closed) return;
    version += 1;
    onThreadSelection();
  };

  selectionEvents?.addEventListener(SELECTED_THREAD_EVENT, handleThreadSelection);

  return {
    begin() {
      version += 1;
      return version;
    },
    isCurrent(token) {
      return !closed && token === version;
    },
    dispose() {
      if (closed) return;
      closed = true;
      version += 1;
      selectionEvents?.removeEventListener(SELECTED_THREAD_EVENT, handleThreadSelection);
    },
  };
}

export async function settleOwnedChatSubmission<T>(
  ownership: ChatSubmissionOwnership,
  operation: () => Promise<T>,
  handlers: {
    onSuccess: (result: T) => void;
    onFailure: (error: unknown) => void;
    onSettled: () => void;
  },
): Promise<void> {
  const token = ownership.begin();
  try {
    const result = await operation();
    if (ownership.isCurrent(token)) handlers.onSuccess(result);
  } catch (error) {
    if (ownership.isCurrent(token)) handlers.onFailure(error);
  } finally {
    if (ownership.isCurrent(token)) handlers.onSettled();
  }
}
