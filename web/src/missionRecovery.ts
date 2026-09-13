import type { UiMission, UiTask } from "./types";

const NORMAL_MISSION_TASK_RETRY_BUDGET = 2;

export type TaskRetryOwnership = {
  begin: (taskId: string) => boolean;
  finish: (taskId: string) => void;
  snapshot: () => Set<string>;
};

export type InterruptedMissionRecovery = {
  description: string;
  prompt: string;
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

export function interruptedMissionRecovery(input: {
  missionStatus?: UiMission["status"] | null;
  goal: string;
  readOnly: boolean;
}): InterruptedMissionRecovery | null {
  if (input.readOnly) return null;
  if (input.missionStatus === "paused") {
    return {
      description: "This Mission is paused. Keep its history intact and continue as fresh work in this Thread when you are ready.",
      prompt: `Continue this work: ${input.goal}`,
    };
  }
  if (input.missionStatus === "cancelled") {
    return {
      description: "This Mission was cancelled. Keep its history intact and continue as fresh work in this Thread.",
      prompt: `Continue this work: ${input.goal}`,
    };
  }
  return null;
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
