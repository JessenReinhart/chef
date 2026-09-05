import type { UiMission, UiTask } from "./types";

export function canRetryMissionTask(input: {
  missionStatus?: UiMission["status"] | null;
  taskStatus: UiTask["status"];
  blockedByApproval: boolean;
  readOnly: boolean;
}): boolean {
  if (input.readOnly) return false;
  if (
    input.missionStatus === "cancelled"
    || input.missionStatus === "completed"
    || input.missionStatus === "paused"
    || input.missionStatus === "waiting_for_approval"
  ) return false;
  if (input.taskStatus === "failed") return true;
  return input.taskStatus === "blocked" && !input.blockedByApproval;
}
