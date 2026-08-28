export const MISSION_PROGRESS_EVENT_TYPES = [
  "mission.*",
  "orchestrator.*",
  "approval.*",
  "node.failed",
  "task.*",
  "session.*",
] as const;

/** Keep Simple Mode subscribed to every runtime family it can translate into human-readable Mission progress. */
export function missionProgressEventStreamUrl(): string {
  return `/api/events?types=${MISSION_PROGRESS_EVENT_TYPES.join(",")}`;
}
