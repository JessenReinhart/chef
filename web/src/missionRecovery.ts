import type { UiMission, UiTask } from "./types";

const NORMAL_MISSION_TASK_RETRY_BUDGET = 2;
const FAILURE_FOLLOWUP_CONTEXT_LIMIT = 320;

export type TaskRetryOwnership = {
  begin: (taskId: string) => boolean;
  finish: (taskId: string) => void;
  snapshot: () => Set<string>;
};

export type InterruptedMissionRecovery = {
  description: string;
  prompt: string;
};

function boundedRecoveryContext(value?: string | null): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length <= FAILURE_FOLLOWUP_CONTEXT_LIMIT
    ? normalized
    : `${normalized.slice(0, FAILURE_FOLLOWUP_CONTEXT_LIMIT - 3)}…`;
}

export function failedMissionFollowupPrompt(input: {
  goal: string;
  failureReason?: string | null;
  lastActivity?: string | null;
}): string {
  const failureReason = boundedRecoveryContext(input.failureReason);
  const lastActivity = boundedRecoveryContext(input.lastActivity);
  const distinctLastActivity = lastActivity && lastActivity !== failureReason ? lastActivity : null;
  const context: string[] = [];
  if (failureReason) context.push(`What happened: ${failureReason}`);
  if (distinctLastActivity) context.push(`Last useful activity: ${distinctLastActivity}`);

  return context.length > 0
    ? `Fix this failed work: ${input.goal}\n\n${context.join("\n")}`
    : `Fix this failed work: ${input.goal}`;
}

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
