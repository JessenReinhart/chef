import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ChefRuntime } from "../main.ts";

type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

/** Adds a workspace-scoped, read-only approval queue and blocker summary. */
export function createBlockerServer(runtime: ChefRuntime, baseServer: Server): Server {
  const baseHandler = baseServer.listeners("request")[0] as RequestHandler | undefined;
  if (!baseHandler) throw new Error("base HTTP server has no request handler");

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
      if (req.method === "GET" && url.pathname === "/api/blockers") {
        const snapshot = await runtime.inspectState();
        const taskById = new Map(snapshot.tasks.map((task) => [task.id, task]));
        const missionById = new Map(snapshot.missions.map((mission) => [mission.id, mission]));

        const pendingApprovals = snapshot.approvals
          .filter((approval) => approval.status === "pending")
          .map((approval) => {
            const task = taskById.get(approval.taskId);
            const mission = task?.missionId ? missionById.get(task.missionId) : undefined;
            return {
              ...approval,
              task: task ? {
                id: task.id,
                title: task.title,
                status: task.status,
                assignedTo: task.assignedTo,
                missionId: task.missionId,
              } : null,
              mission: mission ? {
                id: mission.id,
                goal: mission.goal,
                status: mission.status,
              } : null,
            };
          });

        const blockedTasks = snapshot.tasks
          .filter((task) => task.status === "blocked")
          .map((task) => ({
            id: task.id,
            title: task.title,
            assignedTo: task.assignedTo,
            missionId: task.missionId,
            approvalId: task.approvalId,
            error: task.error,
            updatedAt: task.updatedAt,
          }));

        const failedTasks = snapshot.tasks
          .filter((task) => task.status === "failed")
          .map((task) => ({
            id: task.id,
            title: task.title,
            assignedTo: task.assignedTo,
            missionId: task.missionId,
            error: task.error,
            retryCount: task.retryCount,
            updatedAt: task.updatedAt,
          }));

        sendJson(res, 200, {
          ok: true,
          data: {
            counts: {
              pendingApprovals: pendingApprovals.length,
              blockedTasks: blockedTasks.length,
              failedTasks: failedTasks.length,
            },
            pendingApprovals,
            blockedTasks,
            failedTasks,
          },
        });
        return;
      }

      await baseHandler(req, res);
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}
