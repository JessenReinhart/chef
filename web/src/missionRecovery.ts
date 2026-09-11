import type { UiMission, UiTask } from "./types";

const NORMAL_MISSION_TASK_RETRY_BUDGET = 2;

export type TaskRetryOwnership = {
  begin: (taskId: string) => boolean;
  finish: (taskId: string) => void;
  snapshot: () => Set<string>;
};

export function createTaskRetryOwnership(): TaskRetryOwnership {
  const pendingTaskIds = new Set<string>();
  return {
    begin(taskId) {
      if (pendingTaskIds.has(taskId)) return false;
      pendingTaskIds.add(taskId);
      return true;
    },
    finish(taskId) {
      pendingTaskIds.delete(taskId);
    },
    snapshot() {
      return new Set(pendingTaskIds);
    },
  };
}

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
