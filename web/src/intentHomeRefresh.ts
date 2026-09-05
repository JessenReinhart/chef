import type { UiThread } from "./threadApi";
import { resolveHomeThreadSelection, type HomeThreadSelection } from "./threadSelection";

export type IntentHomeRefreshCore<TSnapshot> = {
  snapshot: TSnapshot;
  threads: UiThread[];
  selection: HomeThreadSelection;
  rememberedThreadId: string | null;
};

/**
 * Runtime progress has a smaller availability boundary than conversation
 * history. Resolve the authoritative workspace + Thread metadata snapshot and
 * let the caller refresh selected-Thread history independently, so a slow
 * history endpoint cannot occupy the heartbeat refresh queue.
 */
export async function loadIntentHomeRefresh<TSnapshot>(input: {
  loadSnapshot: () => Promise<TSnapshot>;
  loadThreads: () => Promise<UiThread[]>;
  rememberedThreadId: () => string | null;
}): Promise<IntentHomeRefreshCore<TSnapshot>> {
  const [snapshot, threads] = await Promise.all([input.loadSnapshot(), input.loadThreads()]);
  const rememberedThreadId = input.rememberedThreadId();
  const selection = resolveHomeThreadSelection(threads, rememberedThreadId);
  return { snapshot, threads, selection, rememberedThreadId };
}
