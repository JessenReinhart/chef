import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Mission, PlanStatus, RuntimeEvent } from "../core/types.ts";
import type { ChefRuntime } from "../main.ts";
import { reactivateFailedMission } from "../persistence/mission-recovery.ts";

type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;

type RetryMissionContext = Pick<Mission, "id" | "planId" | "taskIds">;
type RetryTerminalEvent = "task.completed" | "task.failed" | "task.cancelled";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function retryErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("exceeds retry budget")) {
    return "This work step has used all available retries.";
  }
  return message;
}

function terminalMissionRecoveryMessage(status: "completed" | "cancelled"): string {
  return status === "cancelled"
    ? "This Mission was cancelled, so its history is final. Continue it as new work instead of retrying this step in place."
    : "This Mission is already complete, so its history is final. Start new work instead of retrying this step in place.";
}

function updateRetryMission(
  runtime: ChefRuntime,
  mission: RetryMissionContext,
  status: Mission["status"],
  planStatus?: PlanStatus,
): void {
  const current = runtime.repository.getMission(mission.id);
  if (!current || current.workspaceId !== runtime.workspaceId) return;
  if (current.status === "failed" && status === "active") {
    reactivateFailedMission(runtime.repository, mission.id);
  } else {
    runtime.repository.updateMission(mission.id, { status });
  }
  if (mission.planId && planStatus) runtime.repository.updatePlanStatus(mission.planId, planStatus);
  runtime.repository.appendEvent({
    workspaceId: runtime.workspaceId,
    source: { type: "runtime", id: "recovery" },
    type: "mission.status",
    payload: { missionId: mission.id, status, planId: mission.planId, recovered: true },
  });
}

function reconcileRetryMission(runtime: ChefRuntime, mission: RetryMissionContext): void {
  const current = runtime.repository.getMission(mission.id);
  if (!current || current.workspaceId !== runtime.workspaceId || current.status !== "active") return;

  const tasks = current.taskIds
    .map((taskId) => runtime.repository.getTask(taskId))
    .filter((task) => task !== null);
  if (tasks.length !== current.taskIds.length) {
    updateRetryMission(runtime, mission, "failed", "failed");
    return;
  }

  if (tasks.some((task) => task.status === "failed" || task.status === "cancelled")) {
    updateRetryMission(runtime, mission, "failed", "failed");
    return;
  }
  if (!tasks.every((task) => task.status === "completed")) {
    // A same-task retry does not restart the original plan dispatcher. If
    // other plan work is still unfinished when this retry ends, returning the
    // Mission to failed is truthful and avoids a permanently "working" zombie.
    updateRetryMission(runtime, mission, "failed", "failed");
    return;
  }

  // Mirror the normal Mission terminal handoff: successful execution becomes
  // verifying before completion instead of jumping straight from working to done.
  updateRetryMission(runtime, mission, "verifying");
  updateRetryMission(runtime, mission, "completed", "completed");
}

function watchRetryMission(
  runtime: ChefRuntime,
  taskId: string,
  mission: RetryMissionContext,
): { started: () => void; cancel: () => void } {
  let active = false;
  let terminalEvent: RetryTerminalEvent | null = null;
  let settled = false;

  const settle = (): void => {
    if (!active || !terminalEvent || settled) return;
    settled = true;
    unsubscribe();
    reconcileRetryMission(runtime, mission);
  };

  const onEvent = (event: RuntimeEvent): void => {
    if (event.taskId !== taskId) return;
    if (event.type !== "task.completed" && event.type !== "task.failed" && event.type !== "task.cancelled") return;
    terminalEvent = event.type;
    settle();
  };
  const unsubscribe = runtime.subscribeEvents(onEvent);

  return {
    started() {
      if (active) return;
      active = true;
      updateRetryMission(runtime, mission, "active", "executing");
      settle();
    },
    cancel() {
      if (settled) return;
      settled = true;
      unsubscribe();
    },
  };
}

/**
 * Adds the normal user-facing recovery mutation for failed/blocked work.
 *
 * Retry remains owned by the runtime scheduler. This HTTP layer validates the
 * active workspace and retryable state before delegating. When a terminally
 * failed Mission owns the Task, recovery also reconnects the new worker attempt
 * to that Mission/Plan lifecycle so Simple Mode cannot show failed history while
 * Chef is actively retrying underneath it.
 */
export function createRecoveryServer(runtime: ChefRuntime, baseServer: Server): Server {
  const baseHandler = baseServer.listeners("request")[0] as RequestHandler | undefined;
  if (!baseHandler) throw new Error("base HTTP server has no request handler");

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const retryMatch = url.pathname.match(/^\/api\/nodes\/([^/]+)\/retry$/);

    try {
      if (req.method === "POST" && retryMatch) {
        const taskId = decodeURIComponent(retryMatch[1]);
        const task = runtime.repository.getTask(taskId);
        if (!task || task.workspaceId !== runtime.workspaceId) {
          sendJson(res, 404, { error: `task not found: ${taskId}` });
          return;
        }
        if (task.status !== "failed" && task.status !== "blocked") {
          sendJson(res, 409, { error: `task is not retryable from status ${task.status}` });
          return;
        }

        let retryMission: RetryMissionContext | null = null;
        if (task.missionId) {
          const mission = runtime.repository.getMission(task.missionId);
          if (mission && mission.workspaceId === runtime.workspaceId) {
            if (mission.status === "cancelled" || mission.status === "completed") {
              sendJson(res, 409, { error: terminalMissionRecoveryMessage(mission.status) });
              return;
            }
            if (mission.status === "failed") {
              retryMission = { id: mission.id, planId: mission.planId, taskIds: [...mission.taskIds] };
            }
          }
        }
        if (task.status === "blocked" && task.approvalId) {
          const approval = runtime.repository.getApproval(task.approvalId);
          if (approval?.status === "pending") {
            sendJson(res, 409, { error: "task is waiting for approval and cannot be retried" });
            return;
          }
        }

        const missionWatch = retryMission ? watchRetryMission(runtime, taskId, retryMission) : null;
        try {
          await runtime.retryTask(taskId);
        } catch (error) {
          missionWatch?.cancel();
          sendJson(res, 409, { error: retryErrorMessage(error) });
          return;
        }

        let updated = runtime.repository.getTask(taskId);
        if (!updated || updated.workspaceId !== runtime.workspaceId) {
          missionWatch?.cancel();
          sendJson(res, 500, { error: `task disappeared after retry: ${taskId}` });
          return;
        }
        if (updated.status === "failed" || updated.status === "blocked") {
          missionWatch?.cancel();
          sendJson(res, 409, { error: "retry could not start yet; the task remains blocked" });
          return;
        }

        // Repository patches use `undefined` to mean "leave this field alone".
        // Once a retry genuinely starts, explicitly clear the previous failure
        // so recovered work cannot remain visually attached to a stale error.
        if (updated.error !== undefined) {
          updated = runtime.repository.updateTask(taskId, { error: null as never });
        }
        try {
          missionWatch?.started();
        } catch (error) {
          missionWatch?.cancel();
          sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
          return;
        }

        sendJson(res, 200, { ok: true, data: updated });
        return;
      }

      await baseHandler(req, res);
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}