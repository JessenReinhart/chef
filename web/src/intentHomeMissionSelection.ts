import { selectLivingWorkspaceMission } from "./missionActivityProjection.ts";
import type { UiMission } from "./types.ts";

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
