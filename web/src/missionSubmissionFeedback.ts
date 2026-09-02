export type MissionSubmissionFeedback = {
  input: string;
  optimisticGoal: string;
  chefNote: string | null;
};

export type MissionSubmissionFailureRecovery = MissionSubmissionFeedback & {
  chefNote: string;
};

export const MISSION_SUBMISSION_FAILURE_EVENT = "chef:mission-submission-failure";

const SELECTED_THREAD_KEY = "chef:selected-thread";
const NEW_THREAD_SUBMISSION_KEY = "__chef-new-thread-submission__";
const pendingMissionSubmissionFailures = new Map<string, MissionSubmissionFailureRecovery>();

function currentSubmissionOwnerKey(): string | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(SELECTED_THREAD_KEY) ?? NEW_THREAD_SUBMISSION_KEY;
}

export function missionSubmissionAcknowledgement(): string {
  const ownerKey = currentSubmissionOwnerKey();
  if (ownerKey) pendingMissionSubmissionFailures.delete(ownerKey);
  return "Got it. I’m starting this now.";
}

export function missionSubmissionStarted(submittedText: string): MissionSubmissionFeedback {
  return {
    input: "",
    optimisticGoal: submittedText,
    chefNote: missionSubmissionAcknowledgement(),
  };
}

export function missionSubmissionSucceeded(report?: string | null): MissionSubmissionFeedback {
  const note = report?.trim();
  return {
    input: "",
    optimisticGoal: "",
    chefNote: note || null,
  };
}

export function missionSubmissionFailureRecovery(
  submittedText: string,
  report?: string | null,
): MissionSubmissionFailureRecovery {
  const note = report?.trim();
  return {
    input: submittedText,
    optimisticGoal: "",
    chefNote: note || "I couldn't start that work yet. Your request is ready to try again.",
  };
}

export function rememberMissionSubmissionFailure(
  ownerKey: string,
  recovery: MissionSubmissionFailureRecovery,
): void {
  pendingMissionSubmissionFailures.set(ownerKey, recovery);
}

export function takeMissionSubmissionFailure(ownerKey: string): MissionSubmissionFailureRecovery | null {
  return pendingMissionSubmissionFailures.get(ownerKey) ?? null;
}

export function clearMissionSubmissionFailure(ownerKey: string): void {
  pendingMissionSubmissionFailures.delete(ownerKey);
}
