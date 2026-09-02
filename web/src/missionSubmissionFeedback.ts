export type MissionSubmissionFailureRecovery = {
  input: string;
  optimisticGoal: string;
  chefNote: string;
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
