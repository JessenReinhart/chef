import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { DecisionStatus } from "../core/types.ts";
import type { ChefRuntime } from "../main.ts";

type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;
const DECISION_STATUSES: DecisionStatus[] = ["proposed", "accepted", "rejected"];

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

/** Adds a workspace-scoped, read-only Decision Library projection. */
export function createDecisionServer(runtime: ChefRuntime, baseServer: Server): Server {
  const baseHandler = baseServer.listeners("request")[0] as RequestHandler | undefined;
  if (!baseHandler) throw new Error("base HTTP server has no request handler");

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
      if (req.method === "GET" && url.pathname === "/api/decisions") {
        const status = url.searchParams.get("status");
        if (status && !DECISION_STATUSES.includes(status as DecisionStatus)) {
          sendJson(res, 400, { error: `status must be one of: ${DECISION_STATUSES.join(", ")}` });
          return;
        }
        const type = url.searchParams.get("type");
        const madeBy = url.searchParams.get("madeBy");
        const data = runtime.repository.listDecisions(runtime.workspaceId).filter((decision) =>
          (!status || decision.status === status)
          && (!type || decision.type === type)
          && (!madeBy || decision.madeBy === madeBy),
        );
        sendJson(res, 200, { ok: true, data });
        return;
      }

      const match = url.pathname.match(/^\/api\/decisions\/([^/]+)$/);
      if (req.method === "GET" && match) {
        const decision = runtime.repository.getDecision(decodeURIComponent(match[1]));
        if (!decision || decision.workspaceId !== runtime.workspaceId) {
          sendJson(res, 404, { error: "decision not found" });
          return;
        }
        sendJson(res, 200, { ok: true, data: decision });
        return;
      }

      await baseHandler(req, res);
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}
