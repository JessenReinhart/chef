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

/** Keep human-readable Mission progress subscribed to every runtime family it can translate. */
export function missionProgressEventStreamUrl(): string {
  return `/api/events?types=${MISSION_PROGRESS_EVENT_TYPES.join(",")}`;
}

/**
 * Refresh a mounted progress projection whenever authoritative runtime evidence arrives.
 * The factory seam keeps the behavior executable in Node-based acceptance tests without a browser.
 */
export function subscribeMissionProgressRefresh(
  onRefresh: () => void,
  createStream: MissionProgressEventStreamFactory = (url) => new EventSource(url),
): () => void {
  const stream = createStream(missionProgressEventStreamUrl());
  stream.onmessage = () => onRefresh();
  return () => stream.close();
}
