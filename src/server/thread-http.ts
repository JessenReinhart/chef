import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { ChefRuntime } from "../main.ts";
import type { ThreadMessageContext } from "../core/types.ts";
import { createChatRepository } from "../persistence/chat.ts";
import { createThreadRepository, type ThreadPatch } from "../persistence/threads.ts";

type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;
const THREAD_RECENT_MESSAGE_LIMIT = 8;
const THREAD_RELATED_MISSION_LIMIT = 3;

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

function parseThreadId(pathname: string): { id: string; archive: boolean } | null {
  const match = pathname.match(/^\/api\/threads\/([^/]+)(\/archive)?$/);
  if (!match) return null;
  return { id: decodeURIComponent(match[1]!), archive: Boolean(match[2]) };
}

function parseThreadMessagesId(pathname: string): string | null {
  const match = pathname.match(/^\/api\/threads\/([^/]+)\/messages$/);
  return match ? decodeURIComponent(match[1]!) : null;
}

function parseThreadChatId(pathname: string): string | null {
  const match = pathname.match(/^\/api\/threads\/([^/]+)\/chat$/);
  return match ? decodeURIComponent(match[1]!) : null;
}

function threadContinuityHints(
  thread: { id: string; summary?: string; updatedAt: number },
  missions: ReturnType<ChefRuntime["repository"]["listMissions"]>,
): ThreadMessageContext[] {
  const hints: ThreadMessageContext[] = [];
  const summary = thread.summary?.trim();
  if (summary) {
    hints.push({
      role: "system",
      content: `Thread summary (advisory context only): ${summary}`,
      timestamp: thread.updatedAt,
    });
  }

  const relatedMissions = missions
    .filter((mission) => mission.metadata.threadId === thread.id)
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-THREAD_RELATED_MISSION_LIMIT);
  for (const mission of relatedMissions) {
    hints.push({
      role: "system",
      content: `Prior Mission (${mission.status}; context only): ${mission.goal}`,
      timestamp: mission.createdAt,
    });
  }
  return hints;
}

export function createThreadServer(runtime: ChefRuntime, baseServer: Server): Server {
  const baseHandler = baseServer.listeners("request")[0] as RequestHandler | undefined;
  if (!baseHandler) throw new Error("base HTTP server has no request handler");
  const threads = createThreadRepository(runtime.repository);
  const chat = createChatRepository(runtime.repository);

  const ownedThread = (id: string) => {
    const thread = threads.get(id);
    return thread?.workspaceId === runtime.workspaceId ? thread : null;
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
      const target = parseThreadId(url.pathname);
      const messagesThreadId = parseThreadMessagesId(url.pathname);
      const chatThreadId = parseThreadChatId(url.pathname);
      if (req.method === "GET" && url.pathname === "/api/threads") {
        sendJson(res, 200, { ok: true, data: threads.list(runtime.workspaceId) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/threads") {
        const body = await readBody(req);
        if (typeof body.title !== "string" || !body.title.trim()) {
          sendJson(res, 400, { error: "title is required" });
          return;
        }
        const thread = threads.create({ workspaceId: runtime.workspaceId, title: body.title });
        sendJson(res, 201, { ok: true, data: thread });
        return;
      }

      if (messagesThreadId && req.method === "GET") {
        const thread = ownedThread(messagesThreadId);
        if (!thread) { sendJson(res, 404, { error: "thread not found" }); return; }
        sendJson(res, 200, { ok: true, data: chat.list(runtime.workspaceId, thread.id) });
        return;
      }

      if (chatThreadId && req.method === "POST") {
        const thread = ownedThread(chatThreadId);
        if (!thread) { sendJson(res, 404, { error: "thread not found" }); return; }
        if (thread.status !== "active") { sendJson(res, 409, { error: "thread is archived" }); return; }
        const body = await readBody(req);
        if (typeof body.message !== "string" || !body.message.trim()) {
          sendJson(res, 400, { error: "message is required" });
          return;
        }

        const message = body.message.trim();
        const existingMissions = runtime.repository.listMissions(runtime.workspaceId);
        const recentMessages = [
          ...threadContinuityHints(thread, existingMissions),
          ...chat.list(runtime.workspaceId, thread.id)
            .slice(-THREAD_RECENT_MESSAGE_LIMIT)
            .map(({ role, content, timestamp }) => ({ role, content, timestamp })),
        ];
        chat.insert({ workspaceId: runtime.workspaceId, threadId: thread.id, role: "user", content: message });

        const existingMissionIds = new Set(existingMissions.map((mission) => mission.id));
        const linkOriginatingMission = () => {
          const mission = runtime.repository.listMissions(runtime.workspaceId).find(
            (candidate) => !existingMissionIds.has(candidate.id) && candidate.goal === message,
          );
          if (mission) {
            return runtime.repository.updateMission(mission.id, {
              metadata: { ...mission.metadata, threadId: thread.id },
            });
          }
          return undefined;
        };

        let execution: ReturnType<ChefRuntime["sendUserMessage"]>;
        try {
          execution = runtime.sendUserMessage(message, {
            threadId: thread.id,
            recentMessages,
          });
        } catch (error) {
          linkOriginatingMission();
          throw error;
        }

        let mission = linkOriginatingMission();
        if (!mission) {
          await Promise.resolve();
          mission = linkOriginatingMission();
        }
        if (!mission) {
          throw new Error("Mission was not created before Thread acknowledgement");
        }

        void execution.then((result) => {
          chat.insert({
            workspaceId: runtime.workspaceId,
            threadId: thread.id,
            role: "assistant",
            content: result.report,
            metadata: { missionId: mission!.id, taskIds: result.taskIds, ok: result.ok },
          });
        }).catch((error) => {
          const detail = error instanceof Error ? error.message : String(error);
          chat.insert({
            workspaceId: runtime.workspaceId,
            threadId: thread.id,
            role: "assistant",
            content: `Chef could not finish that work: ${detail}`,
            metadata: { missionId: mission!.id, taskIds: [], ok: false },
          });
        });

        sendJson(res, 202, {
          ok: true,
          data: {
            ok: true,
            accepted: true,
            taskIds: [],
            report: "",
            missionId: mission.id,
            threadId: thread.id,
          },
        });
        return;
      }

      if (target && req.method === "GET" && !target.archive) {
        const thread = ownedThread(target.id);
        if (!thread) { sendJson(res, 404, { error: "thread not found" }); return; }
        sendJson(res, 200, { ok: true, data: thread });
        return;
      }

      if (target && req.method === "PATCH" && !target.archive) {
        const thread = ownedThread(target.id);
        if (!thread) { sendJson(res, 404, { error: "thread not found" }); return; }
        const body = await readBody(req);
        const patch: ThreadPatch = {};
        if (body.title !== undefined) {
          if (typeof body.title !== "string" || !body.title.trim()) { sendJson(res, 400, { error: "title must not be empty" }); return; }
          patch.title = body.title;
        }
        if (body.summary !== undefined) {
          if (body.summary !== null && typeof body.summary !== "string") { sendJson(res, 400, { error: "summary must be a string or null" }); return; }
          patch.summary = body.summary as string | null;
        }
        if (Object.keys(patch).length === 0) { sendJson(res, 400, { error: "no supported thread fields provided" }); return; }
        sendJson(res, 200, { ok: true, data: threads.update(thread.id, patch) });
        return;
      }

      if (target && req.method === "POST" && target.archive) {
        const thread = ownedThread(target.id);
        if (!thread) { sendJson(res, 404, { error: "thread not found" }); return; }
        sendJson(res, 200, { ok: true, data: threads.archive(thread.id) });
        return;
      }

      await baseHandler(req, res);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = error instanceof SyntaxError || error instanceof URIError || /must not be empty/i.test(message) ? 400 : 500;
      sendJson(res, status, { error: message });
    }
  });
}
