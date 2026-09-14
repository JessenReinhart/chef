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

function normalizedRecoveryContext(value?: string | null): string | null {
  const normalized = value
    ?.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || null;
}

function boundedRecoveryContext(value: string | null): string | null {
  if (!value) return null;
  return value.length <= FAILURE_FOLLOWUP_CONTEXT_LIMIT
    ? value
    : `${value.slice(0, FAILURE_FOLLOWUP_CONTEXT_LIMIT - 1)}…`;
}

export function failedMissionFollowupPrompt(input: {
  goal: string;
  failureReason?: string | null;
  lastActivity?: string | null;
}): string {
  const normalizedFailureReason = normalizedRecoveryContext(input.failureReason);
  const normalizedLastActivity = normalizedRecoveryContext(input.lastActivity);
  const failureReason = boundedRecoveryContext(normalizedFailureReason);
  const lastActivity = normalizedLastActivity && normalizedLastActivity !== normalizedFailureReason
    ? boundedRecoveryContext(normalizedLastActivity)
    : null;
  const context: string[] = [];
  if (failureReason) context.push(`What happened: ${failureReason}`);
  if (lastActivity) context.push(`Last useful activity: ${lastActivity}`);

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
