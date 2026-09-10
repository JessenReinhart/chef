import { selectLivingWorkspaceMission } from "./missionActivityProjection.ts";
import { summarizeMissionProgress, summarizeMissionProgressForMission, type MissionProgressItem } from "./missionProgress.ts";
import type { UiMission, UiRuntimeEvent, ViewMode } from "./types.ts";

export interface ChatMissionProgressSnapshot {
  missions: UiMission[];
  events: UiRuntimeEvent[];
}

function missionThreadId(mission: UiMission): string | null {
  const threadId = mission.metadata?.threadId;
  return typeof threadId === "string" && threadId.trim() ? threadId : null;
}

/**
 * Keep Simple Mode progress owned by the foreground Thread while preserving the
 * workspace-wide diagnostic digest used by Power Mode.
 */
export function projectChatMissionProgress(
  snapshot: ChatMissionProgressSnapshot,
  mode: ViewMode,
  selectedThreadId: string | null,
  limit = 5,
  now = Date.now(),
): MissionProgressItem[] {
  if (mode === "power") return summarizeMissionProgress(snapshot.events, limit);
  if (!selectedThreadId) return [];

  const mission = selectLivingWorkspaceMission(
    snapshot.missions.filter((candidate) => missionThreadId(candidate) === selectedThreadId),
  );
  if (!mission) return [];

  return summarizeMissionProgressForMission(
    snapshot.events,
    mission.id,
    mission.taskIds,
    limit,
    now,
  );
}
