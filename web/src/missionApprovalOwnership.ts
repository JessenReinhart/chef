export type TaskOwnedApproval = { taskId: string };

/** Keep approval ownership aligned with the Mission whose status is being projected. */
export function approvalsForMissionTasks<T extends TaskOwnedApproval>(
  approvals: readonly T[],
  taskIds: Iterable<string>,
): T[] {
  const ownedTaskIds = new Set(taskIds);
  return approvals.filter((approval) => ownedTaskIds.has(approval.taskId));
}

export function approvalMissionContextLabel(
  approval: TaskOwnedApproval,
  currentMissionTaskIds: Iterable<string>,
): "For this Mission" | "For earlier Mission" {
  const ownedTaskIds = new Set(currentMissionTaskIds);
  return ownedTaskIds.has(approval.taskId) ? "For this Mission" : "For earlier Mission";
}
