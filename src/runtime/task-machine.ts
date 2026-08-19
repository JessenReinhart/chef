import type { Task, TaskStatus } from "../core/types.ts";
import { newId, now } from "../core/ids.ts";

/**
 * Transition record emitted when a task changes state. The scheduler appends
 * this to the immutable event log through the repository's transaction hook.
 */
export interface TransitionEvent {
  id: string;
  workspaceId: string;
  source: { type: string; id: string };
  type: string;
  payload: unknown;
  taskId: string;
  timestamp: number;
}

export interface TransitionResult {
  task: Task;
  event: TransitionEvent;
}

/**
 * Allowed transitions for the Chef P0 task lifecycle:
 *   pending -> assigned -> running -> { completed | failed | blocked | cancelled }
 *   failed  -> running (bounded retry)
 *   blocked -> running (bounded retry)
 *   any of pending/assigned/running/failed/blocked -> cancelled
 *   terminal states (completed, cancelled) have no outgoing edges.
 */
const ALLOWED: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ["assigned", "blocked", "cancelled"],
  assigned: ["running", "cancelled"],
  running: ["completed", "failed", "blocked", "cancelled"],
  completed: [],
  failed: ["running", "cancelled"],
  blocked: ["assigned", "running", "cancelled"],
  cancelled: [],
};

/**
 * Deterministic task transition validator.
 *
 * The orchestrator emits a *decision*; this machine validates and performs the
 * transition. No LLM may mutate authoritative state directly — every change
 * flows through this single transition table.
 */
export class TaskMachine {
  /** Throws if `from -> to` is not an allowed task transition. */
  static validateTransition(from: TaskStatus, to: TaskStatus): void {
    if (!ALLOWED[from]?.includes(to)) {
      throw new Error(`Invalid task transition: ${from} -> ${to}`);
    }
  }

  /**
   * Validate `task.status -> nextStatus` and produce the updated task plus
   * its transition event. Does not persist — the caller owns persistence and
   * wraps it (with the event append) in a repository transaction.
   */
  static transition(
    task: Task,
    nextStatus: TaskStatus,
    metadata: Partial<Pick<Task, "error" | "resultSummary" | "assignedTo" | "retryCount">> = {},
  ): TransitionResult {
    this.validateTransition(task.status, nextStatus);

    const updated: Task = {
      ...task,
      status: nextStatus,
      updatedAt: now(),
      ...metadata,
    };

    return {
      task: updated,
      event: {
        id: newId(),
        workspaceId: task.workspaceId,
        source: { type: "runtime", id: "task-machine" },
        type: `task.${nextStatus}`,
        payload: { from: task.status, to: nextStatus, ...metadata },
        taskId: task.id,
        timestamp: updated.updatedAt,
      },
    };
  }
}
