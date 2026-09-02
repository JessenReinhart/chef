export type MissionSubmissionFailureRecovery = {
  input: string;
  optimisticGoal: string;
  chefNote: string;
};

export type MissionSubmissionFailureRecoveryState = {
  recovery: MissionSubmissionFailureRecovery | null;
  remaining: Map<string, MissionSubmissionFailureRecovery>;
};

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
  recoveries: ReadonlyMap<string, MissionSubmissionFailureRecovery>,
  ownerKey: string,
  recovery: MissionSubmissionFailureRecovery,
): Map<string, MissionSubmissionFailureRecovery> {
  const next = new Map(recoveries);
  next.set(ownerKey, recovery);
  return next;
}

export function takeMissionSubmissionFailure(
  recoveries: ReadonlyMap<string, MissionSubmissionFailureRecovery>,
  ownerKey: string,
): MissionSubmissionFailureRecoveryState {
  const recovery = recoveries.get(ownerKey) ?? null;
  const remaining = new Map(recoveries);
  if (recovery) remaining.delete(ownerKey);
  return { recovery, remaining };
}
