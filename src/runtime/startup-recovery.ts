import type { MissionStatus, PlanStatus, WorkspaceId } from "../core/types.ts";
import type { Repository } from "../persistence/database.ts";

function terminalMission(status: MissionStatus): boolean {
  return status === "completed" || status === "cancelled" || status === "failed";
}

function terminalPlan(status: PlanStatus): boolean {
  return status === "completed" || status === "failed";
}

type InterruptedMission = {
  taskId?: string;
  taskIdsToBlock?: string[];
  reason: string;
};

/**
 * A fresh process cannot still own in-memory planning/verification or worker
 * PTYs from the previous process. Reconcile those higher-level Mission/Plan
 * states before Scheduler startup turns orphaned Tasks/Sessions into durable
 * recovery states.
 */
export function reconcileInterruptedMissions(repository: Repository, workspaceId: WorkspaceId): void {
  const snapshot = repository.getWorkspaceSnapshot(workspaceId);
  const interruptedMissions = new Map<string, InterruptedMission>();

  for (const task of snapshot.tasks) {
    if (task.status !== "running" || !task.missionId) continue;
    interruptedMissions.set(task.missionId, {
      taskId: task.id,
      reason: "worker interrupted before restart",
    });
  }

  // Planning is also process-owned. A Mission persisted as `planning` has no
  // resumable planner promise after restart, even when no Plan/Task was created
  // yet, so leaving it untouched would make Simple Mode look busy forever.
  for (const mission of snapshot.missions) {
    if (mission.status !== "planning" || interruptedMissions.has(mission.id)) continue;
    interruptedMissions.set(mission.id, {
      reason: "planning interrupted before restart",
    });
  }

  // Worker completion/failure can be durable before the in-memory Mission
  // execution consumes that terminal outcome. A fresh process cannot finish
  // that handoff, so preserve the Task outcome but recover the owning
  // Mission/Plan instead of showing stale working progress.
  const tasksById = new Map(snapshot.tasks.map((task) => [task.id, task]));
  for (const mission of snapshot.missions) {
    if (mission.status !== "active" || interruptedMissions.has(mission.id) || mission.taskIds.length === 0) continue;
    const ownedTasks = mission.taskIds.map((taskId) => tasksById.get(taskId));
    if (ownedTasks.some((task) => task === undefined)) continue;

    const failedTask = ownedTasks.find((task) => task?.status === "failed");
    if (failedTask) {
      interruptedMissions.set(mission.id, {
        taskId: failedTask.id,
        reason: "worker failed before restart handoff",
      });
      continue;
    }

    if (!ownedTasks.every((task) => task?.status === "completed")) continue;
    interruptedMissions.set(mission.id, {
      reason: "worker completed before restart handoff",
    });
  }

  // An active Mission is owned by the in-memory Orchestrator execution, not by
  // the Scheduler alone. Pending Tasks can stay durable for a later retry, but
  // after process restart there is no execution promise left to advance the
  // Plan or move the Mission through verification/completion. Move pending
  // owned work to `blocked` so the existing Simple Mode Retry contract can
  // recover it explicitly instead of leaving an unreachable pending Task.
  for (const mission of snapshot.missions) {
    if (mission.status !== "active" || interruptedMissions.has(mission.id)) continue;
    const pendingTaskIds = mission.taskIds.filter((taskId) => tasksById.get(taskId)?.status === "pending");
    interruptedMissions.set(mission.id, {
      taskIdsToBlock: pendingTaskIds,
      reason: "mission execution interrupted before restart",
    });
  }

  // Verification is owned by the in-memory Mission execution after its worker
  // has already completed. A fresh process cannot resume that promise, so a
  // persisted `verifying` Mission must not reopen as if verification were live.
  for (const mission of snapshot.missions) {
    if (mission.status !== "verifying" || interruptedMissions.has(mission.id)) continue;
    interruptedMissions.set(mission.id, {
      reason: "verification interrupted before restart",
    });
  }

  repository.transaction(() => {
    for (const [missionId, interruption] of interruptedMissions) {
      const mission = repository.getMission(missionId);
      if (!mission || mission.workspaceId !== workspaceId || terminalMission(mission.status)) continue;

      for (const taskId of interruption.taskIdsToBlock ?? []) {
        const task = repository.getTask(taskId);
        if (!task || task.workspaceId !== workspaceId || task.missionId !== mission.id || task.status !== "pending") continue;
        repository.updateTaskStatus(task.id, "blocked", "pending");
        repository.appendEvent({
          workspaceId,
          source: { type: "runtime", id: "startup-recovery" },
          type: "task.blocked",
          payload: {
            from: "pending",
            to: "blocked",
            reason: "mission execution interrupted before restart",
          },
          taskId: task.id,
        });
      }

      if (mission.planId) {
        const plan = repository.getPlan(mission.planId);
        if (plan && plan.workspaceId === workspaceId && !terminalPlan(plan.status)) {
          repository.updatePlanStatus(plan.id, "failed");
        }
      }

      // A paused Mission should not normally own a running Task, but old or
      // interrupted state can contain that combination. Move through the
      // public transition graph rather than bypassing persistence invariants.
      if (mission.status === "paused") {
        repository.updateMission(mission.id, { status: "active" });
      }
      repository.updateMission(mission.id, { status: "failed" });
      repository.appendEvent({
        workspaceId,
        source: { type: "runtime", id: "startup-recovery" },
        type: "mission.status",
        payload: {
          missionId: mission.id,
          status: "failed",
          reason: interruption.reason,
        },
        taskId: interruption.taskId,
      });
    }
  });
}
