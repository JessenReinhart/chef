import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ChefRuntime } from "../main.ts";

type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;
const MAX_CHANNEL_LENGTH = 120;
const MAX_MESSAGE_LENGTH = 10_000;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Workspace-scoped structured-message projection and bounded human room write surface. */
export function createMessageServer(runtime: ChefRuntime, baseServer: Server): Server {
  const baseHandler = baseServer.listeners("request")[0] as RequestHandler | undefined;
  if (!baseHandler) throw new Error("base HTTP server has no request handler");

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
      if (req.method === "GET" && url.pathname === "/api/messages/channels") {
        const counts = new Map<string, number>();
        for (const message of runtime.repository.listMessages(runtime.workspaceId)) {
          const channel = message.channel?.trim();
          if (!channel) continue;
          counts.set(channel, (counts.get(channel) ?? 0) + 1);
        }
        const data = [...counts.entries()]
          .map(([channel, messageCount]) => ({ channel, messageCount }))
          .sort((a, b) => a.channel.localeCompare(b.channel));
        sendJson(res, 200, { ok: true, data });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/messages") {
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch {
          sendJson(res, 400, { error: "request body must be valid JSON" });
          return;
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          sendJson(res, 400, { error: "request body must be an object" });
          return;
        }
        const input = body as Record<string, unknown>;
        const channel = typeof input.channel === "string" ? input.channel.trim() : "";
        const text = typeof input.text === "string" ? input.text.trim() : "";
        if (!channel) {
          sendJson(res, 400, { error: "channel is required" });
          return;
        }
        if (channel.length > MAX_CHANNEL_LENGTH) {
          sendJson(res, 400, { error: `channel must be at most ${MAX_CHANNEL_LENGTH} characters` });
          return;
        }
        if (!text) {
          sendJson(res, 400, { error: "text is required" });
          return;
        }
        if (text.length > MAX_MESSAGE_LENGTH) {
          sendJson(res, 400, { error: `text must be at most ${MAX_MESSAGE_LENGTH} characters` });
          return;
        }

        const message = runtime.repository.transaction(() => {
          const created = runtime.repository.insertMessage({
            workspaceId: runtime.workspaceId,
            from: "human",
            channel,
            type: "message",
            payload: { text },
          });
          runtime.repository.appendEvent({
            workspaceId: runtime.workspaceId,
            source: { type: "human", id: "human" },
            type: "message.sent",
            payload: { messageId: created.id, channel, type: created.type },
          });
          return created;
        });
        sendJson(res, 201, { ok: true, data: message });
        return;
      }

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
