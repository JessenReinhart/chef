import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ChefRuntime } from "../main.ts";

type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

/** Read-only, workspace-scoped structured-message projection for collaboration UI. */
export function createMessageServer(runtime: ChefRuntime, baseServer: Server): Server {
  const baseHandler = baseServer.listeners("request")[0] as RequestHandler | undefined;
  if (!baseHandler) throw new Error("base HTTP server has no request handler");

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
      if (req.method === "GET" && url.pathname === "/api/messages") {
        const channel = url.searchParams.get("channel") ?? undefined;
        const agentId = url.searchParams.get("agentId") ?? undefined;
        const direction = url.searchParams.get("direction") ?? undefined;
        if (direction && direction !== "in" && direction !== "out") {
          sendJson(res, 400, { error: "direction must be in or out" });
          return;
        }
        if (direction && !agentId) {
          sendJson(res, 400, { error: "agentId is required when direction is set" });
          return;
        }

        let data = runtime.repository.listMessages(runtime.workspaceId, channel);
        if (agentId) {
          data = data.filter((message) => direction === "in"
            ? message.to === agentId
            : direction === "out"
              ? message.from === agentId
              : message.from === agentId || message.to === agentId);
        }
        sendJson(res, 200, { ok: true, data });
        return;
      }

      await baseHandler(req, res);
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}
