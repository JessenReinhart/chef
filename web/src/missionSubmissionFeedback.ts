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

export type MissionSubmissionComposerState = {
  locked: boolean;
  label: "Starting…" | "Give to Chef";
};

export const MISSION_SUBMISSION_FAILURE_EVENT = "chef:mission-submission-failure";
export const ACCEPTED_MISSION_PROJECTION_GRACE_MS = 30_000;

const SELECTED_THREAD_KEY = "chef:selected-thread";
const NEW_THREAD_SUBMISSION_KEY = "__chef-new-thread-submission__";
const pendingMissionSubmissionFailures = new Map<string, MissionSubmissionFailureRecovery>();
const pendingAcceptedMissionSubmissions = new Map<string, AcceptedMissionSubmission>();
const acceptedMissionSubmissionTimes = new WeakMap<AcceptedMissionSubmission, number>();

function submissionOwnerKey(threadId: string | null): string {
  return threadId ?? NEW_THREAD_SUBMISSION_KEY;
}

function currentSubmissionOwnerKey(): string | null {
  if (typeof localStorage === "undefined") return null;
  return submissionOwnerKey(localStorage.getItem(SELECTED_THREAD_KEY));
}

function acceptedMissionSubmissionIsFresh(
  accepted: AcceptedMissionSubmission,
  now: number,
  graceMs: number,
): boolean {
  let acceptedAt = acceptedMissionSubmissionTimes.get(accepted);
  if (acceptedAt === undefined) {
    acceptedAt = now;
    acceptedMissionSubmissionTimes.set(accepted, acceptedAt);
  }
  return now - acceptedAt < graceMs;
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
  acceptedAt = Date.now(),
): AcceptedMissionSubmission {
  const accepted = { threadId, missionId, goal: submittedText };
  acceptedMissionSubmissionTimes.set(accepted, acceptedAt);
  return accepted;
}

export function rememberAcceptedMissionSubmission(accepted: AcceptedMissionSubmission): void {
  if (!acceptedMissionSubmissionTimes.has(accepted)) {
    acceptedMissionSubmissionTimes.set(accepted, Date.now());
  }
  pendingAcceptedMissionSubmissions.set(submissionOwnerKey(accepted.threadId), accepted);
}

export function acceptedMissionSubmissionForThread(
  threadId: string | null,
  now = Date.now(),
  graceMs = ACCEPTED_MISSION_PROJECTION_GRACE_MS,
): AcceptedMissionSubmission | null {
  const ownerKey = submissionOwnerKey(threadId);
  const accepted = pendingAcceptedMissionSubmissions.get(ownerKey) ?? null;
  if (!accepted) return null;
  if (acceptedMissionSubmissionIsFresh(accepted, now, graceMs)) return accepted;
  pendingAcceptedMissionSubmissions.delete(ownerKey);
  return null;
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

/**
 * Keep the visible Simple Mode handoff aligned with the durable Thread-owned
 * submission guard. Component-local accepted state can disappear after a
 * surface remount or be intentionally withheld while another Thread owns the
 * foreground; the remembered guard remains authoritative until the exact
 * accepted Mission appears in state. A bounded grace window prevents an
 * acknowledged-but-never-projected Mission from locking Simple Mode forever.
 */
export function acceptedMissionSubmissionIsPending(
  accepted: AcceptedMissionSubmission | null,
  selectedThreadId: string | null,
  missions: Array<{ id: string }>,
  now = Date.now(),
  graceMs = ACCEPTED_MISSION_PROJECTION_GRACE_MS,
): boolean {
  const visibleAccepted = accepted?.threadId === selectedThreadId
    ? accepted
    : acceptedMissionSubmissionForThread(selectedThreadId, now, graceMs);
  if (!visibleAccepted) return false;
  if (!acceptedMissionSubmissionIsFresh(visibleAccepted, now, graceMs)) {
    const ownerKey = submissionOwnerKey(selectedThreadId);
    if (pendingAcceptedMissionSubmissions.get(ownerKey) === visibleAccepted) {
      pendingAcceptedMissionSubmissions.delete(ownerKey);
    }
    return false;
  }
  return !missions.some((mission) => mission.id === visibleAccepted.missionId);
}

export function missionSubmissionComposerState(input: {
  submitting: boolean;
  acceptedPending: boolean;
}): MissionSubmissionComposerState {
  const locked = input.submitting || input.acceptedPending;
  return {
    locked,
    label: locked ? "Starting…" : "Give to Chef",
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
