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

/** Keep human-readable Mission progress subscribed to every runtime family it can translate. */
export function missionProgressEventStreamUrl(): string {
  return `/api/events?types=${MISSION_PROGRESS_EVENT_TYPES.join(",")}`;
}

/**
 * Refresh a mounted progress projection whenever authoritative runtime evidence arrives.
 * Keep at most one refresh in flight and collapse a burst into one trailing refresh so
 * high-frequency worker output cannot create an unbounded /api/state request storm.
 */
export function subscribeMissionProgressRefresh(
  onRefresh: MissionProgressRefresh,
  createStream: MissionProgressEventStreamFactory = (url) => new EventSource(url),
): () => void {
  const stream = createStream(missionProgressEventStreamUrl());
  let closed = false;
  let refreshing = false;
  let queued = false;

  const refresh = () => {
    if (closed) return;
    if (refreshing) {
      queued = true;
      return;
    }

    refreshing = true;
    Promise.resolve(onRefresh())
      .catch(() => undefined)
      .finally(() => {
        refreshing = false;
        if (!closed && queued) {
          queued = false;
          refresh();
        }
      });
  };

  stream.onmessage = refresh;
  return () => {
    closed = true;
    queued = false;
    stream.close();
  };
}
