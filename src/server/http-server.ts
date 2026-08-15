import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { ChefRuntime } from "../main.ts";
import type { RuntimeEvent } from "../core/types.ts";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;
const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
  connection: "keep-alive",
} as const;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  let raw = "";
  req.on("data", (chunk: Buffer) => {
    raw += chunk.toString("utf8");
  });
  req.on("end", () => {
    try {
      resolve(raw.length === 0 ? {} : JSON.parse(raw));
    } catch (error) {
      reject(error);
    }
  });
  req.on("error", reject);
  return promise;
}

/** Read-only HTTP/SSE projection over a Chef runtime (spec §4: UI subscribes, runtime is authoritative). */
export function createHttpServer(runtime: ChefRuntime): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    try {
      if (req.method === "GET" && path === "/api/state") {
        const snapshot = await runtime.inspectState();
        sendJson(res, 200, snapshot);
        return;
      }

      if (req.method === "GET" && path === "/api/events") {
        res.writeHead(200, SSE_HEADERS);
        res.write("retry: 1000\n\n");
        const unsubscribe = runtime.subscribeEvents((event: RuntimeEvent) => {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        });
        const heartbeat = setInterval(() => {
          res.write(": ping\n\n");
        }, 15_000);
        req.on("close", () => {
          clearInterval(heartbeat);
          unsubscribe();
        });
        return;
      }

      if (req.method === "POST" && path === "/api/sessions/send") {
        const body = (await readBody(req)) as { sessionId?: string; data?: string };
        if (typeof body.sessionId !== "string" || typeof body.data !== "string") {
          sendJson(res, 400, { error: "sessionId and data are required" });
          return;
        }
        await runtime.sendInput(body.sessionId, body.data);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && path === "/api/sessions/interrupt") {
        const body = (await readBody(req)) as { sessionId?: string };
        if (typeof body.sessionId !== "string") {
          sendJson(res, 400, { error: "sessionId is required" });
          return;
        }
        await runtime.interruptSession(body.sessionId);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && path === "/api/sessions/resize") {
        const body = (await readBody(req)) as { sessionId?: string; cols?: number; rows?: number };
        if (typeof body.sessionId !== "string" || typeof body.cols !== "number" || typeof body.rows !== "number") {
          sendJson(res, 400, { error: "sessionId, cols and rows are required" });
          return;
        }
        await runtime.resizeSession(body.sessionId, body.cols, body.rows);
        sendJson(res, 200, { ok: true });
        return;
      }

      sendJson(res, 404, { error: `not found: ${req.method} ${path}` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { error: message });
    }
  });
}
