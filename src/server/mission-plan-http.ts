import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ChefRuntime } from "../main.ts";

interface MissionPlanTaskState {
  id: string;
  status: string;
  assignedTo?: string;
  resultSummary?: string;
  error?: string;
}

interface MissionPlanProjection {
  missionId: string;
  currentPlanId?: string;
  plans: Array<{
    id: string;
    goal: string;
    status: string;
    createdAt: number;
    updatedAt?: number;
    isCurrent: boolean;
    tasks: unknown[];
    taskIds: string[];
    taskStates: MissionPlanTaskState[];
  }>;
}

type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

/** Adds a Mission-scoped plan-history projection for UI visualization. */
export function createMissionPlanServer(runtime: ChefRuntime, baseServer: Server): Server {
  const baseHandler = baseServer.listeners("request")[0] as RequestHandler | undefined;
  if (!baseHandler) throw new Error("base HTTP server has no request handler");

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const match = url.pathname.match(/^\/api\/missions\/([^/]+)\/plans$/);

    try {
      if (req.method === "GET" && match) {
        const missionId = decodeURIComponent(match[1]);
        const mission = runtime.repository.getMission(missionId);
        if (!mission || mission.workspaceId !== runtime.workspaceId) {
          sendJson(res, 404, { error: "mission not found" });
          return;
        }

        const plans = runtime.repository
          .listPlans(runtime.workspaceId)
          .filter((plan) => plan.missionId === mission.id)
          .map((plan) => ({
            id: plan.id,
            goal: plan.goal,
            status: plan.status,
            createdAt: plan.createdAt,
            updatedAt: plan.updatedAt,
            isCurrent: mission.planId === plan.id,
            tasks: plan.tasks,
            taskIds: plan.taskIds,
            taskStates: plan.taskIds
              .map((taskId) => runtime.repository.getTask(taskId))
              .filter((task) => task !== null && task.workspaceId === runtime.workspaceId)
              .map((task) => ({
                id: task.id,
                status: task.status,
                assignedTo: task.assignedTo,
                resultSummary: task.resultSummary,
                error: task.error,
              })),
          }));

        const data: MissionPlanProjection = {
          missionId: mission.id,
          currentPlanId: mission.planId,
          plans,
        };
        sendJson(res, 200, { ok: true, data });
        return;
      }

      await baseHandler(req, res);
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}
