import { SELECTED_THREAD_EVENT } from "./threadApi.ts";

export const MISSION_PROGRESS_EVENT_TYPES = [
  "mission.*",
  "orchestrator.*",
  "approval.*",
  "node.failed",
  "task.*",
  "session.*",
] as const;

export type MissionProgressEventStream = Pick<EventSource, "onmessage" | "close">;
export type MissionProgressEventStreamFactory = (url: string) => MissionProgressEventStream;
export type MissionProgressRefresh = () => void | Promise<void>;
export type MissionProgressRefreshQueue = { trigger: () => void; close: () => void };
type MissionProgressSelectionEvents = Pick<EventTarget, "addEventListener" | "removeEventListener">;

/** Keep human-readable Mission progress subscribed to every runtime family it can translate. */
export function missionProgressEventStreamUrl(): string {
  return `/api/events?types=${MISSION_PROGRESS_EVENT_TYPES.join(",")}`;
}

/**
 * Give every refresh source one shared one-in-flight + one-trailing budget.
 * Timers, live invalidations, and mount-time reads can all trigger this queue without
 * multiplying authoritative state requests while a slower refresh is still running.
 */
export function createMissionProgressRefreshQueue(onRefresh: MissionProgressRefresh): MissionProgressRefreshQueue {
  let closed = false;
  let refreshing = false;
  let queued = false;

  const trigger = () => {
    if (closed) return;
    if (refreshing) {
      queued = true;
      return;
    }

    refreshing = true;
    Promise.resolve()
      .then(onRefresh)
      .catch(() => undefined)
      .finally(() => {
        refreshing = false;
        if (!closed && queued) {
          queued = false;
          trigger();
        }
      });
  };

  return {
    trigger,
    close: () => {
      closed = true;
      queued = false;
    },
  };
}

export function createMissionProgressRefreshHub(
  createStream: MissionProgressEventStreamFactory,
): (onRefresh: MissionProgressRefresh) => () => void {
  let stream: MissionProgressEventStream | null = null;
  const listeners = new Set<() => void>();

  const ensureStream = () => {
    if (stream) return;
    stream = createStream(missionProgressEventStreamUrl());
    stream.onmessage = () => {
      for (const listener of [...listeners]) listener();
    };
  };

  return (onRefresh) => {
    const refresh = createMissionProgressRefreshQueue(onRefresh);
    listeners.add(refresh.trigger);
    ensureStream();

    return () => {
      refresh.close();
      listeners.delete(refresh.trigger);
      if (listeners.size === 0 && stream) {
        stream.close();
        stream = null;
      }
    };
  };
}

const subscribeSharedMissionProgressRefresh = createMissionProgressRefreshHub(
  (url) => new EventSource(url),
);

/**
 * Refresh a mounted progress projection whenever authoritative runtime evidence arrives.
 * Browser consumers share one ref-counted EventSource, while each projection keeps its
 * own one-in-flight + one-trailing refresh budget. Supplying a factory creates an
 * isolated hub for deterministic tests.
 */
export function subscribeMissionProgressRefresh(
  onRefresh: MissionProgressRefresh,
  createStream?: MissionProgressEventStreamFactory,
): () => void {
  if (createStream) return createMissionProgressRefreshHub(createStream)(onRefresh);
  return subscribeSharedMissionProgressRefresh(onRefresh);
}

/**
 * Treat the live stream and Simple Mode foreground Thread changes as invalidation signals,
 * then rebuild UI state from an authoritative projection. Every source shares one
 * coalesced queue so a slow read cannot multiply requests while ownership is changing.
 */
export function subscribeMissionProgressProjection<T>(
  loadProjection: () => Promise<T>,
  applyProjection: (projection: T) => void,
  createStream?: MissionProgressEventStreamFactory,
  selectionEvents: MissionProgressSelectionEvents | null = typeof window !== "undefined" ? window : null,
): () => void {
  let closed = false;
  const projectionRefresh = createMissionProgressRefreshQueue(async () => {
    const projection = await loadProjection();
    if (!closed) applyProjection(projection);
  });
  const unsubscribe = subscribeMissionProgressRefresh(projectionRefresh.trigger, createStream);
  const handleThreadSelection = () => projectionRefresh.trigger();
  selectionEvents?.addEventListener(SELECTED_THREAD_EVENT, handleThreadSelection);

  projectionRefresh.trigger();

  return () => {
    closed = true;
    selectionEvents?.removeEventListener(SELECTED_THREAD_EVENT, handleThreadSelection);
    projectionRefresh.close();
    unsubscribe();
  };
}
