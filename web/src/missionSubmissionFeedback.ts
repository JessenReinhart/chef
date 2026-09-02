export type MissionSubmissionFailureRecovery = {
  input: string;
  optimisticGoal: string;
  chefNote: string;
};

export const MISSION_SUBMISSION_FAILURE_EVENT = "chef:mission-submission-failure";

const pendingMissionSubmissionFailures = new Map<string, MissionSubmissionFailureRecovery>();

export function missionSubmissionAcknowledgement(): string {
  return "Got it. I’m starting this now.";
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
  const recovery = pendingMissionSubmissionFailures.get(ownerKey) ?? null;
  if (recovery) pendingMissionSubmissionFailures.delete(ownerKey);
  return recovery;
}
