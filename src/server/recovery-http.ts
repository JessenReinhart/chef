import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ChefRuntime } from "../main.ts";

type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

/**
 * Adds the normal user-facing recovery mutation for failed/blocked work.
 *
 * Retry remains owned by the runtime scheduler. This HTTP layer only validates
 * active-workspace ownership and retryable state before delegating, so Simple
 * Mode never needs Workbench/runtime internals to recover ordinary failures.
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

        try {
          await runtime.retryTask(taskId);
        } catch (error) {
          sendJson(res, 409, { error: error instanceof Error ? error.message : String(error) });
          return;
        }

        const updated = runtime.repository.getTask(taskId);
        if (!updated || updated.workspaceId !== runtime.workspaceId) {
          sendJson(res, 500, { error: `task disappeared after retry: ${taskId}` });
          return;
        }
        if (updated.status === "failed" || updated.status === "blocked") {
          sendJson(res, 409, { error: "retry could not start yet; the task remains blocked" });
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
