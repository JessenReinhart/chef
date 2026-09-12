import type { MissionStatus, PlanStatus, WorkspaceId } from "../core/types.ts";
import type { Repository } from "../persistence/database.ts";

function terminalMission(status: MissionStatus): boolean {
  return status === "completed" || status === "cancelled" || status === "failed";
}

function terminalPlan(status: PlanStatus): boolean {
  return status === "completed" || status === "failed";
}

/**
 * A fresh process cannot still own PTYs persisted as running by the previous
 * process. Reconcile the higher-level Mission/Plan before Scheduler startup
 * turns those orphaned Tasks/Sessions into their durable recovery states.
 */
export function reconcileInterruptedMissions(repository: Repository, workspaceId: WorkspaceId): void {
  const snapshot = repository.getWorkspaceSnapshot(workspaceId);
  const recoveredMissionIds = new Set<string>();

  repository.transaction(() => {
    for (const task of snapshot.tasks) {
      if (task.status !== "running" || !task.missionId || recoveredMissionIds.has(task.missionId)) continue;

      const mission = repository.getMission(task.missionId);
      if (!mission || mission.workspaceId !== workspaceId || terminalMission(mission.status)) continue;

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
        payload: { status: "failed", reason: "worker interrupted before restart" },
        taskId: task.id,
      });
      recoveredMissionIds.add(mission.id);
    }
  });
}
