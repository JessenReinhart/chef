import { selectLivingWorkspaceMission } from "./missionActivityProjection.ts";
import type { UiMission } from "./types.ts";

const TERMINAL_MISSION_STATUSES = new Set<UiMission["status"]>(["completed", "failed", "cancelled"]);

/**
 * A completion summary may only publish while the exact Mission that requested
 * it still owns the Simple Mode foreground. A newer accepted Mission must make
 * terminal history stale immediately, even while /api/state is still catching
 * up to the durable 202 acknowledgement.
 */
export function terminalMissionSummaryIsCurrent(
  missions: UiMission[],
  expectedMissionId: string,
  acceptedPendingMissionId: string | null = null,
): boolean {
  if (acceptedPendingMissionId && acceptedPendingMissionId !== expectedMissionId) return false;
  const currentMission = selectLivingWorkspaceMission(missions);
  return currentMission?.id === expectedMissionId
    && TERMINAL_MISSION_STATUSES.has(currentMission.status);
}
