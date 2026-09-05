import type { UiThread } from "./threadApi";
import { resolveHomeThreadSelection, type HomeThreadSelection } from "./threadSelection";
import type { ChatMessage } from "./types";

export type IntentHomeRefreshCore<TSnapshot> = {
  snapshot: TSnapshot;
  threads: UiThread[];
  selection: HomeThreadSelection;
  rememberedThreadId: string | null;
};

export type IntentHomeRefreshResult<TSnapshot> = IntentHomeRefreshCore<TSnapshot> & {
  messages: ChatMessage[];
};

/**
 * Publish workspace runtime state as soon as its authoritative reads settle.
 * Conversation history is a separate, slower surface and must not hold back
 * Mission/task/event progress that is already available to Simple Mode.
 */
export async function loadIntentHomeRefresh<TSnapshot>(input: {
  loadSnapshot: () => Promise<TSnapshot>;
  loadThreads: () => Promise<UiThread[]>;
  rememberedThreadId: () => string | null;
  loadMessages: (threadId: string) => Promise<ChatMessage[]>;
  onCore: (core: IntentHomeRefreshCore<TSnapshot>) => void;
}): Promise<IntentHomeRefreshResult<TSnapshot>> {
  const [snapshot, threads] = await Promise.all([input.loadSnapshot(), input.loadThreads()]);
  const rememberedThreadId = input.rememberedThreadId();
  const selection = resolveHomeThreadSelection(threads, rememberedThreadId);
  const core = { snapshot, threads, selection, rememberedThreadId };

  input.onCore(core);

  const selectedThreadId = selection.selectedThread?.id;
  const messages = selectedThreadId ? await input.loadMessages(selectedThreadId) : [];
  return { ...core, messages };
}
