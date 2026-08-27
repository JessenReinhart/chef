import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { ChefRuntime } from "../main.ts";

type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, reject) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => { raw += chunk.toString("utf8"); });
    req.on("end", () => {
      try {
        const parsed = raw ? JSON.parse(raw) : {};
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new SyntaxError("request body must be a JSON object");
        }
        resolveBody(parsed as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

/**
 * Compatibility boundary for the Living Workspace's legacy `/api/chat` send.
 *
 * The runtime owns long-running Mission execution. The HTTP request must only
 * acknowledge that the work was accepted; progress then arrives through the
 * existing durable Mission projection and `/api/chat/stream` events. Waiting
 * for the whole Mission here makes the browser request look frozen even though
 * orchestration is supposed to be observable independently.
 */
export function createImmediateChatServer(runtime: ChefRuntime, baseServer: Server): Server {
  const baseHandler = baseServer.listeners("request")[0] as RequestHandler | undefined;
  if (!baseHandler) throw new Error("base HTTP server has no request handler");

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method !== "POST" || url.pathname !== "/api/chat") {
      await baseHandler(req, res);
      return;
    }

    try {
      const body = await readBody(req);
      if (typeof body.message !== "string" || !body.message.trim()) {
        sendJson(res, 400, { error: "message is required" });
        return;
      }

      const message = body.message.trim();
      const priorMissionIds = new Set(
        runtime.repository.listMissions(runtime.workspaceId).map((mission) => mission.id),
      );

      // Calling the async runtime entry point synchronously creates and persists
      // the Mission before its first planner await. Do not await the returned
      // Promise here: the UI observes that durable Mission while work continues.
      const execution = runtime.sendChatMessage(message);
      const mission = runtime.repository.listMissions(runtime.workspaceId).find(
        (candidate) => !priorMissionIds.has(candidate.id),
      );

      console.log(`[Chef] Work accepted${mission ? ` (${mission.id})` : ""}: ${message}`);
      void execution.then((result) => {
        console.log(`[Chef] Work ${result.ok ? "completed" : "stopped"}${mission ? ` (${mission.id})` : ""}.`);
      }).catch((error) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`[Chef] Work failed${mission ? ` (${mission.id})` : ""}: ${detail}`);
      });

      sendJson(res, 202, {
        ok: true,
        data: {
          ok: true,
          taskIds: [],
          report: "",
          missionId: mission?.id,
          accepted: true,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, error instanceof SyntaxError ? 400 : 500, { error: message });
    }
  });
}
