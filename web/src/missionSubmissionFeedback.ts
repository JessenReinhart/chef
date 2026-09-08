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
const ACCEPTED_MISSION_STORAGE_PREFIX = "chef:accepted-mission-submission:";
const pendingMissionSubmissionFailures = new Map<string, MissionSubmissionFailureRecovery>();
const pendingAcceptedMissionSubmissions = new Map<string, AcceptedMissionSubmission>();
const acceptedMissionSubmissionTimes = new WeakMap<AcceptedMissionSubmission, number>();

type PersistedAcceptedMissionSubmission = AcceptedMissionSubmission & {
  acceptedAt: number;
};

function submissionOwnerKey(threadId: string | null): string {
  return threadId ?? NEW_THREAD_SUBMISSION_KEY;
}

function acceptedMissionStorageKey(threadId: string | null): string {
  return `${ACCEPTED_MISSION_STORAGE_PREFIX}${encodeURIComponent(submissionOwnerKey(threadId))}`;
}

function acceptedMissionStorage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function removePersistedAcceptedMissionSubmission(threadId: string | null): void {
  try {
    acceptedMissionStorage()?.removeItem(acceptedMissionStorageKey(threadId));
  } catch {
    // Storage is an optional reload-safety layer; in-memory ownership still applies.
  }
}

function persistAcceptedMissionSubmission(
  accepted: AcceptedMissionSubmission,
  acceptedAt: number,
): void {
  try {
    acceptedMissionStorage()?.setItem(
      acceptedMissionStorageKey(accepted.threadId),
      JSON.stringify({ ...accepted, acceptedAt } satisfies PersistedAcceptedMissionSubmission),
    );
  } catch {
    // Storage can be unavailable or quota-blocked without breaking the current session.
  }
}

function hydrateAcceptedMissionSubmission(
  threadId: string | null,
  now: number,
  graceMs: number,
): AcceptedMissionSubmission | null {
  const storage = acceptedMissionStorage();
  if (!storage) return null;
  const key = acceptedMissionStorageKey(threadId);
  let raw: string | null = null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<PersistedAcceptedMissionSubmission>;
    if (
      parsed.threadId !== threadId
      || typeof parsed.missionId !== "string"
      || parsed.missionId.trim() === ""
      || typeof parsed.goal !== "string"
      || typeof parsed.acceptedAt !== "number"
      || !Number.isFinite(parsed.acceptedAt)
      || parsed.acceptedAt > now
      || now - parsed.acceptedAt >= graceMs
    ) {
      storage.removeItem(key);
      return null;
    }
    const accepted: AcceptedMissionSubmission = {
      threadId,
      missionId: parsed.missionId,
      goal: parsed.goal,
    };
    acceptedMissionSubmissionTimes.set(accepted, parsed.acceptedAt);
    pendingAcceptedMissionSubmissions.set(submissionOwnerKey(threadId), accepted);
    return accepted;
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      // Ignore cleanup failure; malformed storage must never lock the composer.
    }
    return null;
  }
}

function currentSubmissionOwnerKey(): string | null {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return null;
    return submissionOwnerKey(storage.getItem(SELECTED_THREAD_KEY));
  } catch {
    return null;
  }
}

function acceptedMissionSubmissionTime(
  accepted: AcceptedMissionSubmission,
  now: number,
): number {
  let acceptedAt = acceptedMissionSubmissionTimes.get(accepted);
  if (acceptedAt === undefined) {
    acceptedAt = now;
    acceptedMissionSubmissionTimes.set(accepted, acceptedAt);
  }
  return acceptedAt;
}

function acceptedMissionSubmissionIsFresh(
  accepted: AcceptedMissionSubmission,
  now: number,
  graceMs: number,
): boolean {
  return now - acceptedMissionSubmissionTime(accepted, now) < graceMs;
}

function mostRecentAcceptedMissionSubmission(
  localAccepted: AcceptedMissionSubmission | null,
  rememberedAccepted: AcceptedMissionSubmission | null,
  now: number,
): AcceptedMissionSubmission | null {
  if (!localAccepted) return rememberedAccepted;
  if (!rememberedAccepted) return localAccepted;
  return acceptedMissionSubmissionTime(rememberedAccepted, now) >= acceptedMissionSubmissionTime(localAccepted, now)
    ? rememberedAccepted
    : localAccepted;
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
  const acceptedAt = acceptedMissionSubmissionTime(accepted, Date.now());
  pendingAcceptedMissionSubmissions.set(submissionOwnerKey(accepted.threadId), accepted);
  persistAcceptedMissionSubmission(accepted, acceptedAt);
}

export function acceptedMissionSubmissionForThread(
  threadId: string | null,
  now = Date.now(),
  graceMs = ACCEPTED_MISSION_PROJECTION_GRACE_MS,
): AcceptedMissionSubmission | null {
  const ownerKey = submissionOwnerKey(threadId);
  const accepted = pendingAcceptedMissionSubmissions.get(ownerKey)
    ?? hydrateAcceptedMissionSubmission(threadId, now, graceMs);
  if (!accepted) return null;
  if (acceptedMissionSubmissionIsFresh(accepted, now, graceMs)) return accepted;
  pendingAcceptedMissionSubmissions.delete(ownerKey);
  removePersistedAcceptedMissionSubmission(threadId);
  return null;
}

export function observeAcceptedMissionSubmission(
  threadId: string | null,
  missions: Array<{ id: string }>,
): void {
  const accepted = acceptedMissionSubmissionForThread(threadId);
  if (accepted && missions.some((mission) => mission.id === accepted.missionId)) {
    clearAcceptedMissionSubmission(threadId);
  }
}

export function clearAcceptedMissionSubmission(threadId: string | null): void {
  pendingAcceptedMissionSubmissions.delete(submissionOwnerKey(threadId));
  removePersistedAcceptedMissionSubmission(threadId);
}

/**
 * Keep the visible Simple Mode handoff aligned with the durable Thread-owned
 * submission guard. Component-local accepted state can disappear after a
 * surface remount or page reload, or lag behind a newer same-Thread acknowledgement;
 * the newest accepted handoff remains authoritative until its exact Mission appears
 * in state. A bounded grace window prevents an acknowledged-but-never-projected
 * Mission from locking Simple Mode forever.
 */
export function acceptedMissionSubmissionIsPending(
  accepted: AcceptedMissionSubmission | null,
  selectedThreadId: string | null,
  missions: Array<{ id: string }>,
  now = Date.now(),
  graceMs = ACCEPTED_MISSION_PROJECTION_GRACE_MS,
): boolean {
  const localAccepted = accepted?.threadId === selectedThreadId ? accepted : null;
  const rememberedAccepted = acceptedMissionSubmissionForThread(selectedThreadId, now, graceMs);
  const visibleAccepted = mostRecentAcceptedMissionSubmission(localAccepted, rememberedAccepted, now);
  if (!visibleAccepted) return false;
  if (!acceptedMissionSubmissionIsFresh(visibleAccepted, now, graceMs)) {
    const ownerKey = submissionOwnerKey(selectedThreadId);
    if (pendingAcceptedMissionSubmissions.get(ownerKey) === visibleAccepted) {
      clearAcceptedMissionSubmission(selectedThreadId);
    }
    return false;
  }
  const projected = missions.some((mission) => mission.id === visibleAccepted.missionId);
  if (projected) {
    const ownerKey = submissionOwnerKey(selectedThreadId);
    const remembered = pendingAcceptedMissionSubmissions.get(ownerKey);
    if (remembered?.missionId === visibleAccepted.missionId) {
      clearAcceptedMissionSubmission(selectedThreadId);
    }
    return false;
  }
  return true;
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
