import type { ApprovalId, TaskId, Timestamp, WorkspaceId } from "./types.ts";

export type ApprovalStatus = "pending" | "accepted" | "rejected";
export type ApprovalDecision = Exclude<ApprovalStatus, "pending">;

export interface Approval {
  id: ApprovalId;
  workspaceId: WorkspaceId;
  taskId: TaskId;
  status: ApprovalStatus;
  requester: string;
  approver?: string;
  reason: string;
  createdAt: Timestamp;
  resolvedAt?: Timestamp;
}
