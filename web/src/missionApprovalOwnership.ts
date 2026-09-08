export type TaskOwnedApproval = { taskId: string };

/** Keep approval ownership aligned with the Mission whose status is being projected. */
export function approvalsForMissionTasks<T extends TaskOwnedApproval>(
  approvals: readonly T[],
  taskIds: Iterable<string>,
): T[] {
  const ownedTaskIds = new Set(taskIds);
  return approvals.filter((approval) => ownedTaskIds.has(approval.taskId));
}
