export type MissionSubmissionFeedback = {
  input: string;
  optimisticGoal: string;
  chefNote: string | null;
};

export type MissionSubmissionFailureRecovery = MissionSubmissionFeedback & {
  chefNote: string;
};

export type AcceptedMissionSubmission = {
  threadId: string | null;
  missionId: string;
  goal: string;
};

export const MISSION_SUBMISSION_FAILURE_EVENT = "chef:mission-submission-failure";

const SELECTED_THREAD_KEY = "chef:selected-thread";
const NEW_THREAD_SUBMISSION_KEY = "__chef-new-thread-submission__";
const pendingMissionSubmissionFailures = new Map<string, MissionSubmissionFailureRecovery>();
const pendingAcceptedMissionSubmissions = new Map<string, AcceptedMissionSubmission>();

function submissionOwnerKey(threadId: string | null): string {
  return threadId ?? NEW_THREAD_SUBMISSION_KEY;
}

function currentSubmissionOwnerKey(): string | null {
  if (typeof localStorage === "undefined") return null;
  return submissionOwnerKey(localStorage.getItem(SELECTED_THREAD_KEY));
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

export function missionSubmissionAccepted(
  threadId: string | null,
  missionId: string,
  submittedText: string,
): AcceptedMissionSubmission {
  return { threadId, missionId, goal: submittedText };
}

export function rememberAcceptedMissionSubmission(accepted: AcceptedMissionSubmission): void {
  pendingAcceptedMissionSubmissions.set(submissionOwnerKey(accepted.threadId), accepted);
}

export function acceptedMissionSubmissionForThread(threadId: string | null): AcceptedMissionSubmission | null {
  return pendingAcceptedMissionSubmissions.get(submissionOwnerKey(threadId)) ?? null;
}

export function observeAcceptedMissionSubmission(
  threadId: string | null,
  missions: Array<{ id: string }>,
): void {
  const ownerKey = submissionOwnerKey(threadId);
  const accepted = pendingAcceptedMissionSubmissions.get(ownerKey);
  if (accepted && missions.some((mission) => mission.id === accepted.missionId)) {
    pendingAcceptedMissionSubmissions.delete(ownerKey);
  }
}

export function clearAcceptedMissionSubmission(threadId: string | null): void {
  pendingAcceptedMissionSubmissions.delete(submissionOwnerKey(threadId));
}

export function acceptedMissionSubmissionIsPending(
  accepted: AcceptedMissionSubmission | null,
  selectedThreadId: string | null,
  missions: Array<{ id: string }>,
): boolean {
  return Boolean(
    accepted
      && accepted.threadId === selectedThreadId
      && !missions.some((mission) => mission.id === accepted.missionId),
  );
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
