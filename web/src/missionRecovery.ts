import type { UiMission, UiTask } from "./types";

const NORMAL_MISSION_TASK_RETRY_BUDGET = 2;

export function canRetryMissionTask(input: {
  missionStatus?: UiMission["status"] | null;
  taskStatus: UiTask["status"];
  retryCount?: number;
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
  if ((input.retryCount ?? 0) >= NORMAL_MISSION_TASK_RETRY_BUDGET) return false;
  if (input.taskStatus === "failed") return true;
  return input.taskStatus === "blocked" && !input.blockedByApproval;
}
