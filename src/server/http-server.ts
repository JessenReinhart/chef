import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { ChefRuntime } from "../main.ts";
import type { RuntimeEvent, PlanTask, PlanStatus } from "../core/types.ts";
import { buildPlanGraph } from "../core/graph.ts";

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

      if (req.method === "GET" && path === "/api/graph") {
        const snapshot = await runtime.inspectState();
        sendJson(res, 200, buildPlanGraph(snapshot));
        return;
      }

      if (req.method === "GET" && path === "/api/events") {
        const typesParam = url.searchParams.get("types");
        const typeFilters = typesParam ? typesParam.split(",").map((t) => t.trim()).filter(Boolean) : null;
        const afterSeqParam = url.searchParams.get("afterSeq");
        const afterSeq = afterSeqParam ? Number(afterSeqParam) : undefined;

        res.writeHead(200, SSE_HEADERS);
        res.write("retry: 1000\n\n");

        // Replay buffered events since afterSeq first (restart-safe catch-up).
        if (afterSeq !== undefined && Number.isFinite(afterSeq)) {
          for (const event of runtime.repository.listEvents(runtime.workspaceId, { afterSeq })) {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          }
        }

        const unsubscribe = runtime.subscribeEvents((event: RuntimeEvent) => {
          if (typeFilters && typeFilters.length > 0) {
            const matches = typeFilters.some((filter) =>
              filter.endsWith("*") ? event.type.startsWith(filter.slice(0, -1)) : event.type === filter
            );
            if (!matches) return;
          }
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

      // ============================================================
      // Chat endpoints (Chat with Chef — SSE streaming)
      // ============================================================
      if (req.method === "GET" && path === "/api/chat/messages") {
        const messages = runtime.repository.listMessages(runtime.workspaceId, "chat");
        sendJson(res, 200, { ok: true, data: messages });
        return;
      }

      if (req.method === "POST" && path === "/api/chat") {
        const body = (await readBody(req)) as { message?: string };
        if (typeof body.message !== "string" || body.message.length === 0) {
          sendJson(res, 400, { error: "message is required" });
          return;
        }
        const result = await runtime.sendChatMessage(body.message);
        sendJson(res, 200, { ok: result.ok, data: result });
        return;
      }

      if (req.method === "GET" && path === "/api/chat/stream") {
        const afterSeqParam = url.searchParams.get("afterSeq");
        const afterSeq = afterSeqParam ? Number(afterSeqParam) : undefined;

        res.writeHead(200, SSE_HEADERS);
        res.write("retry: 1000\n\n");

        // Replay buffered chat events since afterSeq first (restart-safe catch-up).
        if (afterSeq !== undefined && Number.isFinite(afterSeq)) {
          for (const event of runtime.repository.listEvents(runtime.workspaceId, { afterSeq })) {
            if (event.type.startsWith("chat.")) {
              res.write(`data: ${JSON.stringify(event)}\n\n`);
            }
          }
        }

        const unsubscribe = runtime.subscribeEvents((event: RuntimeEvent) => {
          if (!event.type.startsWith("chat.")) return;
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
      const approvalMatch = path.match(/^\/api\/approvals\/([^/]+)\/(accept|reject)$/);
      if (req.method === "POST" && approvalMatch) {
        const [, approvalId, decision] = approvalMatch;
        const body = (await readBody(req)) as { approver?: string };
        const approver = typeof body.approver === "string" && body.approver.length > 0 ? body.approver : "ui";
        await runtime.resolveApproval(approvalId, decision, approver);
        sendJson(res, 200, { ok: true });
        return;
      }
      // ============================================================
      // Workflow / Plan endpoints (spec §5.4)
      // ============================================================
      if (req.method === "GET" && path === "/api/workflows") {
        const snapshot = await runtime.inspectState();
        sendJson(res, 200, { ok: true, data: snapshot.plans });
        return;
      }

      const workflowIdMatch = path.match(/^\/api\/workflows\/([^/]+)$/);
      if (req.method === "GET" && workflowIdMatch) {
        const [, planId] = workflowIdMatch;
        const plan = runtime.repository.getPlan(planId);
        if (!plan) {
          sendJson(res, 404, { error: `plan not found: ${planId}` });
          return;
        }
        sendJson(res, 200, { ok: true, data: plan });
        return;
      }

      if (req.method === "POST" && path === "/api/workflows") {
        const body = (await readBody(req)) as { goal?: string; tasks?: unknown[] };
        if (typeof body.goal !== "string" || body.goal.length === 0) {
          sendJson(res, 400, { error: "goal is required" });
          return;
        }
        const plan = runtime.repository.insertPlan({
          workspaceId: runtime.workspaceId,
          goal: body.goal,
          status: "draft",
          tasks: (body.tasks as PlanTask[]) ?? [],
          taskIds: [],
        });
        sendJson(res, 201, { ok: true, data: plan });
        return;
      }

      if (req.method === "PATCH" && workflowIdMatch) {
        const [, planId] = workflowIdMatch;
        const body = (await readBody(req)) as { status?: PlanStatus };
        const validStatuses: PlanStatus[] = ["draft", "proposed", "approved", "executing", "completed", "failed"];
        if (typeof body.status !== "string" || !validStatuses.includes(body.status as PlanStatus)) {
          sendJson(res, 400, { error: "status must be one of: draft, proposed, approved, executing, completed, failed" });
          return;
        }
        const plan = runtime.repository.updatePlanStatus(planId, body.status as PlanStatus);
        sendJson(res, 200, { ok: true, data: plan });
        return;
      }

      // ============================================================
      // Template endpoints (spec §13)
      // ============================================================
      if (req.method === "GET" && path === "/api/templates") {
        const templates = runtime.repository.listTemplates(runtime.workspaceId);
        sendJson(res, 200, { ok: true, data: templates });
        return;
      }

      const templateIdMatch = path.match(/^\/api\/templates\/([^/]+)$/);
      if (req.method === "GET" && templateIdMatch) {
        const [, templateId] = templateIdMatch;
        const template = runtime.repository.getTemplate(templateId);
        if (!template) {
          sendJson(res, 404, { error: `template not found: ${templateId}` });
          return;
        }
        sendJson(res, 200, { ok: true, data: template });
        return;
      }

      if (req.method === "POST" && path === "/api/templates") {
        const body = (await readBody(req)) as { name?: string; description?: string; nodes?: unknown[]; metadata?: Record<string, unknown> };
        if (typeof body.name !== "string" || body.name.length === 0) {
          sendJson(res, 400, { error: "name is required" });
          return;
        }
        const template = runtime.repository.insertTemplate({
          workspaceId: runtime.workspaceId,
          name: body.name,
          description: body.description ?? "",
          nodes: body.nodes ?? [],
          metadata: body.metadata ?? {},
        });
        sendJson(res, 201, { ok: true, data: template });
        return;
      }

      if (req.method === "PATCH" && templateIdMatch) {
        const [, templateId] = templateIdMatch;
        const body = (await readBody(req)) as { name?: string; description?: string; nodes?: unknown[]; metadata?: Record<string, unknown> };
        const template = runtime.repository.updateTemplate(templateId, body);
        sendJson(res, 200, { ok: true, data: template });
        return;
      }

      if (req.method === "DELETE" && templateIdMatch) {
        const [, templateId] = templateIdMatch;
        runtime.repository.deleteTemplate(templateId);
        sendJson(res, 200, { ok: true });
        return;
      }

      // ============================================================
      // Node-run endpoints (task + session for node execution)
      // ============================================================
      if (req.method === "POST" && path === "/api/nodes/run") {
        const body = (await readBody(req)) as { nodeId?: string; title?: string; assignedTo?: string; workflowNodeId?: string };
        if (typeof body.nodeId !== "string" || body.nodeId.length === 0) {
          sendJson(res, 400, { error: "nodeId is required" });
          return;
        }
        const task = runtime.repository.createTask({
          workspaceId: runtime.workspaceId,
          title: body.title ?? `Run node ${body.nodeId}`,
          description: `Execute node ${body.nodeId}`,
          status: "pending",
          assignedTo: body.assignedTo,
          workflowNodeId: body.workflowNodeId ?? body.nodeId,
        });
        sendJson(res, 201, { ok: true, data: { taskId: task.id } });
        return;
      }

      const nodeTaskIdMatch = path.match(/^\/api\/nodes\/([^/]+)\/status$/);
      if (req.method === "GET" && nodeTaskIdMatch) {
        const [, taskId] = nodeTaskIdMatch;
        const task = runtime.repository.getTask(taskId);
        if (!task) {
          sendJson(res, 404, { error: `task not found: ${taskId}` });
          return;
        }
        sendJson(res, 200, { ok: true, data: task });
        return;
      }

      const nodeCancelMatch = path.match(/^\/api\/nodes\/([^/]+)\/cancel$/);
      if (req.method === "POST" && nodeCancelMatch) {
        const [, taskId] = nodeCancelMatch;
        await runtime.cancelTask(taskId);
        sendJson(res, 200, { ok: true });
        return;
      }

      // ============================================================
      // Tool endpoints
      // ============================================================
      if (req.method === "GET" && path === "/api/tools") {
        const tools = [
          { type: "code_exec", description: "Execute code in a sandbox", params: { language: "string", code: "string" } },
          { type: "file_read", description: "Read a file", params: { path: "string" } },
          { type: "file_write", description: "Write a file", params: { path: "string", content: "string" } },
          { type: "web_search", description: "Search the web", params: { query: "string", limit: "number" } },
          { type: "fetch", description: "Fetch a URL", params: { url: "string" } },
          { type: "bash", description: "Run a shell command", params: { command: "string", cwd: "string" } },
        ];
        sendJson(res, 200, { ok: true, data: tools });
        return;
      }

      if (req.method === "POST" && path === "/api/tools/execute") {
        const body = (await readBody(req)) as { type?: string; params?: Record<string, unknown> };
        if (typeof body.type !== "string" || body.type.length === 0) {
          sendJson(res, 400, { error: "type is required" });
          return;
        }
        sendJson(res, 501, { error: "tool execution not implemented — no tool runner registered" });
        return;
      }

      // ============================================================
      // Inspector endpoints (enhanced projection for UI)
      // ============================================================
      if (req.method === "GET" && path === "/api/inspector/state") {
        const snapshot = await runtime.inspectState();
        sendJson(res, 200, { ok: true, data: snapshot });
        return;
      }

      if (req.method === "GET" && path === "/api/inspector/sessions") {
        const sessions = runtime.repository.listSessions(runtime.workspaceId);
        const liveOnly = url.searchParams.get("live") === "true";
        const data = liveOnly ? sessions.filter((s) => s.status === "spawning" || s.status === "running") : sessions;
        sendJson(res, 200, { ok: true, data });
        return;
      }

      if (req.method === "GET" && path === "/api/inspector/events") {
        const afterSeq = url.searchParams.get("afterSeq");
        const limit = url.searchParams.get("limit");
        const events = runtime.repository.listEvents(runtime.workspaceId, {
          afterSeq: afterSeq ? Number(afterSeq) : undefined,
          limit: limit ? Number(limit) : undefined,
        });
        sendJson(res, 200, { ok: true, data: events });
        return;
      }

      if (req.method === "GET" && path === "/api/inspector/artifacts") {
        const artifacts = runtime.repository.listArtifacts(runtime.workspaceId);
        sendJson(res, 200, { ok: true, data: artifacts });
        return;
      }



      sendJson(res, 404, { error: `not found: ${req.method} ${path}` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { error: message });
    }
  });
}
