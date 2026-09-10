import { selectLivingWorkspaceMission } from "./missionActivityProjection.ts";
import type { UiMission } from "./types.ts";

export type IntentHomeThreadMissionSignal = "active" | "attention" | null;

/**
 * Pick the Mission that owns Simple Mode's foreground work surface.
 *
 * A just-accepted submission intentionally hides older Mission state until the
 * accepted Mission appears in the durable snapshot. Otherwise the foreground
 * follows Chef's shared living-Mission contract: ongoing work wins over newer
 * terminal history, then the newest terminal Mission wins once nothing is
 * still progressing.
 */
export function selectIntentHomeMission(
  missions: UiMission[],
  acceptedSubmissionPending: boolean,
): UiMission | null {
  if (acceptedSubmissionPending) return null;
  return selectLivingWorkspaceMission(missions);
}

/**
 * Keep Thread navigation aligned with the same foreground Mission that owns
 * Current work. Normal users should be able to spot a Thread that needs action
 * without opening it or switching to Power Mode, while completed history stays
 * visually quiet.
 */
export function intentHomeThreadMissionSignal(
  missions: UiMission[],
): IntentHomeThreadMissionSignal {
  const mission = selectIntentHomeMission(missions, false);
  if (!mission) return null;

  if (mission.status === "planning" || mission.status === "active" || mission.status === "verifying") {
    return "active";
  }
  if (
    mission.status === "failed"
    || mission.status === "blocked"
    || mission.status === "cancelled"
    || mission.status === "paused"
    || mission.status === "waiting_for_approval"
  ) {
    return "attention";
  }
  return null;
}
