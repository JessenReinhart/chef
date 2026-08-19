import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { ChefRuntime } from "../main.ts";
import type { ApprovalDecision, RuntimeEvent, PlanTask, PlanStatus, CanvasPatch, CanvasEdgeType } from "../core/types.ts";
import { buildPlanGraph } from "../core/graph.ts";
import { capabilityRegistry, type Role } from "../runtime/capabilities.ts";
import type { Repository } from "../persistence/database.ts";

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

      if (req.method === "GET" && path === "/api/missions") {
        sendJson(res, 200, { ok: true, data: runtime.repository.listMissions(runtime.workspaceId) });
        return;
      }

      const missionAction = path.match(/^\/api\/missions\/([^/]+)\/(pause|resume|cancel)$/);
      if (req.method === "POST" && missionAction) {
        const [, missionId, action] = missionAction;
        const current = runtime.repository.getMission(missionId);
        if (!current || current.workspaceId !== runtime.workspaceId) { sendJson(res, 404, { error: `mission not found: ${missionId}` }); return; }
        const mission = action === "pause"
          ? await runtime.pauseMission(missionId)
          : action === "resume"
            ? runtime.resumeMission(missionId)
            : await runtime.cancelMission(missionId);
        sendJson(res, 200, { ok: true, data: mission });
        return;
      }

      const missionIdRoute = path.match(/^\/api\/missions\/([^/]+)$/);
      if (req.method === "PATCH" && missionIdRoute) {
        const missionId = missionIdRoute[1];
        const current = runtime.repository.getMission(missionId);
        if (!current || current.workspaceId !== runtime.workspaceId) { sendJson(res, 404, { error: `mission not found: ${missionId}` }); return; }
        const body = (await readBody(req)) as { goal?: string };
        if (!body.goal?.trim()) { sendJson(res, 400, { error: "goal is required" }); return; }
        const mission = await runtime.redirectMission(missionId, body.goal);
        sendJson(res, 200, { ok: true, data: mission });
        return;
      }

      if (req.method === "GET" && path === "/api/automations") {
        sendJson(res, 200, { ok: true, data: runtime.repository.listAutomations(runtime.workspaceId) });
        return;
      }

      if (req.method === "POST" && path === "/api/automations") {
        const body = (await readBody(req)) as { name?: string; description?: string; nodeIds?: string[]; edges?: Array<{ source: string; target: string; type: "dependency" | "control" | "error" | "approval" }>; trigger?: Record<string, unknown> };
        if (!body.name) { sendJson(res, 400, { error: "name is required" }); return; }
        const automation = runtime.repository.insertAutomation({ workspaceId: runtime.workspaceId, name: body.name, description: body.description, nodeIds: body.nodeIds, edges: body.edges, trigger: body.trigger });
        runtime.repository.appendEvent({ workspaceId: runtime.workspaceId, source: { type: "automation", id: automation.id }, type: "automation.created", payload: { automationId: automation.id } });
        sendJson(res, 201, { ok: true, data: automation });
        return;
      }

      const automationAction = path.match(/^\/api\/automations\/([^/]+)\/(run|stop)$/);
      if (req.method === "POST" && automationAction) {
        const [, automationId, action] = automationAction;
        const run = action === "run" ? runtime.runAutomation(automationId) : await runtime.stopAutomation(automationId);
        sendJson(res, 200, { ok: true, data: run });
        return;
      }

      if (req.method === "GET" && path === "/api/graph") {
        const snapshot = await runtime.inspectState();
        sendJson(res, 200, buildPlanGraph(snapshot));
        return;
      }
      // Harness detection registry: every known specialized candidate plus the
      // generic PTY fallback, with live availability from the runtime registry.
      if (req.method === "GET" && path === "/api/harnesses") {
        const available = new Set(runtime.specializedHarnesses.availableIds());
        const KNOWN: Array<{ id: string; name: string; type: string }> = [
          { id: "claude-code", name: "Claude Code", type: "claude-code" },
          { id: "pi", name: "Pi", type: "pi" },
          { id: "omp", name: "OMP", type: "omp" },
          { id: "freebuff", name: "Freebuff", type: "freebuff" },
          { id: "generic", name: "Generic Terminal", type: "generic" },
        ];
        const data = KNOWN.map((h) => ({
          id: h.id,
          name: h.name,
          type: h.type,
          available: h.id === "generic" ? true : available.has(h.id),
        }));
        sendJson(res, 200, { ok: true, data });
        return;
      }

      if (req.method === "GET" && path === "/api/llm/status") {
        sendJson(res, 200, { ok: true, data: runtime.llmStatus });
        return;
      }

      if (req.method === "GET" && path === "/api/capabilities") {
        const requestedRole = url.searchParams.get("role") ?? "engineer";
        const roles: Role[] = ["engineer", "orchestrator", "human"];
        if (!roles.includes(requestedRole as Role)) {
          sendJson(res, 400, { error: "role must be one of: engineer, orchestrator, human" });
          return;
        }
        const role = requestedRole as Role;
        sendJson(res, 200, { ok: true, data: { role, policy: capabilityRegistry.getPolicy(role) } });
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

      // Peer messaging (message_peer): write a message envelope into the
      // session's inbox. The body may carry an optional `from` (defaults to
      // "peer") and a required `text`.
      const messageMatch = path.match(/^\/api\/sessions\/([^/]+)\/message$/);
      if (req.method === "POST" && messageMatch) {
        const [, sessionId] = messageMatch;
        const body = (await readBody(req)) as { from?: string; text?: string };
        if (typeof body.text !== "string" || body.text.length === 0) {
          sendJson(res, 400, { error: "text is required" });
          return;
        }
        const from = typeof body.from === "string" && body.from.length > 0 ? body.from : "peer";
        await runtime.sendPeerMessage(sessionId, from, body.text);
        sendJson(res, 200, { ok: true });
        return;
      }
      const approvalMatch = path.match(/^\/api\/approvals\/([^/]+)\/(accept|reject)$/);
      if (req.method === "POST" && approvalMatch) {
        const [, approvalId, decision] = approvalMatch;
        const body = (await readBody(req)) as { approver?: string };
        const approver = typeof body.approver === "string" && body.approver.length > 0 ? body.approver : "ui";
        await runtime.resolveApproval(approvalId, decision as ApprovalDecision, approver);
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

      if (req.method === "POST" && path === "/api/nodes") {
        const body = (await readBody(req)) as {
          type?: string;
          title?: string;
          kind?: string;
          config?: Record<string, unknown>;
          position?: { x: number; y: number };
          dependencies?: string[];
          autoDispatch?: boolean;
          assignedTo?: string;
        };
        if (typeof body.type !== "string" || body.type.length === 0) {
          sendJson(res, 400, { error: "type is required" });
          return;
        }
        const inferredHarness = body.type.startsWith("harness.")
          ? body.type.slice("harness.".length)
          : body.type === "tool.terminal"
            ? "generic"
            : undefined;
        const assignedTo = body.assignedTo ?? inferredHarness;
        const task = runtime.repository.createTask({
          workspaceId: runtime.workspaceId,
          title: body.title ?? `Node ${body.type}`,
          description: `Blueprint node: ${body.type}`,
          status: "pending",
          workflowNodeId: body.type,
          contextRefs: [],
          dependencies: body.dependencies,
          assignedTo,
        });
        await runtime.patchCanvas(runtime.workspaceId, { upsertNodes: [{
          id: task.id,
          taskId: task.id,
          label: task.title,
          kind: body.kind === "terminal" ? "tool" : (body.kind as "agent" | "tool" | "data" | "approval" | "system" | undefined),
          liveStatus: "offline",
          config: body.config ?? {},
          position: body.position,
        }] });
        let execution: { status: "started" | "configuration_required"; reason?: string } | undefined;
        if (body.autoDispatch && assignedTo) {
          await runtime.activateNode(task.id);
          execution = { status: "started" };
        } else if (body.autoDispatch) {
          execution = {
            status: "configuration_required",
            reason: body.type === "tool.browser"
              ? "Browser nodes require a browser action and URL; use /api/browser/:sessionId/action when configured"
              : `Node type ${body.type} has no executable harness`,
          };
        }
        sendJson(res, 201, { ok: true, data: { taskId: task.id, workflowNodeId: task.workflowNodeId, assignedTo, execution } });
        return;
      }

      const nodeIdMatch = path.match(/^\/api\/nodes\/([^/]+)$/);
      const nodeActivateMatch = path.match(/^\/api\/nodes\/([^/]+)\/activate$/);
      if (req.method === "POST" && nodeActivateMatch) {
        const node = await runtime.activateNode(nodeActivateMatch[1]);
        sendJson(res, 200, { ok: true, data: node });
        return;
      }
      const nodeMessageMatch = path.match(/^\/api\/nodes\/([^/]+)\/message$/);
      if (req.method === "POST" && nodeMessageMatch) {
        const body = (await readBody(req)) as { message?: string };
        if (!body.message) { sendJson(res, 400, { error: "message is required" }); return; }
        await runtime.interveneNode(nodeMessageMatch[1], body.message);
        sendJson(res, 202, { ok: true });
        return;
      }
      if (req.method === "PATCH" && nodeIdMatch) {
        const [, taskId] = nodeIdMatch;
        const body = (await readBody(req)) as {
          title?: string;
          config?: Record<string, unknown>;
          position?: { x: number; y: number };
          dependencies?: string[];
        };
        const current = runtime.repository.getTask(taskId);
        if (!current) {
          sendJson(res, 404, { error: `node not found: ${taskId}` });
          return;
        }
        const patch: Record<string, unknown> = {};
        if (typeof body.title === "string") patch.title = body.title;
        if (body.config !== undefined) patch.contextRefs = body.config;
        if (body.dependencies !== undefined) patch.dependencies = body.dependencies;
        if (Object.keys(patch).length > 0) {
          const updated = runtime.repository.updateTask(taskId, patch as Parameters<Repository["updateTask"]>[1]);
          sendJson(res, 200, { ok: true, data: updated });
        } else {
          sendJson(res, 200, { ok: true, data: current });
        }
        return;
      }

      if (req.method === "DELETE" && nodeIdMatch) {
        const [, taskId] = nodeIdMatch;
        // Note: tasks are never truly deleted; we mark cancelled
        const task = runtime.repository.getTask(taskId);
        if (!task) {
          sendJson(res, 404, { error: `node not found: ${taskId}` });
          return;
        }
        runtime.repository.updateTask(taskId, { status: "cancelled" });
        sendJson(res, 200, { ok: true });
        return;
      }

      // Typed relationships: only dependency edges affect task readiness.
      if (req.method === "POST" && path === "/api/edges") {
        const body = (await readBody(req)) as { source?: string; target?: string; type?: "communication" | "context" | "delegation" | "dependency" | "control" | "error" | "approval" };
        if (typeof body.source !== "string" || typeof body.target !== "string") {
          sendJson(res, 400, { error: "source and target required" });
          return;
        }
        // Validate both tasks exist
        const src = runtime.repository.getTask(body.source);
        const tgt = runtime.repository.getTask(body.target);
        if (!src || !tgt) {
          sendJson(res, 404, { error: "source or target task not found" });
          return;
        }
        const type = body.type ?? "dependency";
        const result = await runtime.patchCanvas(runtime.workspaceId, { upsertEdges: [{ source: body.source, target: body.target, type }] });
        if (!result.ok) { sendJson(res, 422, result); return; }
        // Ordering is explicit: relationship edges never mutate task dependencies.
        // Persist it only after the canvas relationship was accepted.
        if (type === "dependency") {
          runtime.repository.updateTask(body.target, { dependencies: [...new Set([...(tgt.dependencies ?? []), body.source])] });
        }
        sendJson(res, 201, { ok: true, data: result.edges?.find((edge) => edge.source === body.source && edge.target === body.target && edge.type === type) });
        return;
      }

      const edgeIdMatch = path.match(/^\/api\/edges\/([^/]+)$/);
      if (req.method === "DELETE" && edgeIdMatch) {
        // edgeId format: source->target[:type]. `?type=` is also accepted to
        // avoid ambiguity for callers whose node ids contain colons.
        const [, edgeIdRaw] = edgeIdMatch;
        const edgeId = decodeURIComponent(edgeIdRaw);
        const arrow = edgeId.lastIndexOf("->");
        if (arrow <= 0 || arrow === edgeId.length - 2) {
          sendJson(res, 400, { error: "invalid edge id format (use source->target[:type])" });
          return;
        }
        const source = edgeId.slice(0, arrow);
        let target = edgeId.slice(arrow + 2);
        const allowedTypes: CanvasEdgeType[] = ["communication", "context", "delegation", "dependency", "control", "error", "approval"];
        let typeRaw = url.searchParams.get("type") ?? undefined;
        if (!typeRaw) {
          const suffix = target.lastIndexOf(":");
          const candidate = suffix > 0 ? target.slice(suffix + 1) : "";
          if (allowedTypes.includes(candidate as CanvasEdgeType)) {
            typeRaw = candidate;
            target = target.slice(0, suffix);
          }
        }
        const type = typeRaw ?? "dependency";
        if (!allowedTypes.includes(type as CanvasEdgeType)) {
          sendJson(res, 400, { error: `invalid edge type: ${type}` });
          return;
        }
        const edgeType = type as CanvasEdgeType;
        const tgt = runtime.repository.getTask(target);
        if (!tgt) {
          sendJson(res, 404, { error: `target task not found: ${target}` });
          return;
        }
        const edge = runtime.listCanvas(runtime.workspaceId).edges.find(
          (candidate) => candidate.source === source && candidate.target === target && candidate.type === edgeType,
        );
        if (!edge) {
          sendJson(res, 404, { error: `edge not found: ${source}->${target}:${edgeType}` });
          return;
        }
        const result = await runtime.patchCanvas(runtime.workspaceId, { deleteEdges: [{ source, target, type: edgeType }] });
        if (!result.ok) { sendJson(res, 422, result); return; }
        if (edgeType === "dependency") {
          const deps = (tgt.dependencies ?? []).filter((dependency) => dependency !== source);
          runtime.repository.updateTask(target, { dependencies: deps });
        }
        sendJson(res, 200, { ok: true });
        return;
      }
      // Canvas graph patch (new, additive — existing /api/nodes, /api/edges,
      // DELETE /api/edges/:source->target behavior is unchanged).
      if (req.method === "POST" && path === "/api/canvas/patch") {
        const body = (await readBody(req)) as CanvasPatch;
        const result = await runtime.patchCanvas(runtime.workspaceId, body);
        sendJson(res, result.ok ? 200 : 422, result);
        return;
      }

      // Dispatch: manually trigger scheduler
      if (req.method === "POST" && path === "/api/dispatch") {
        const dispatched = await runtime.dispatchPending();
        sendJson(res, 200, { ok: true, data: { dispatched } });
        return;
      }

      // Existing /api/nodes/run etc remain for backward compat
      if (req.method === "POST" && path === "/api/nodes/run") {
      }

      // ============================================================
      // Tool endpoints
      // ============================================================
      if (req.method === "GET" && path === "/api/tools") {
        const tools: Array<{ type: string; description: string; params: Record<string, string>; capability: string }> = [];
        if (runtime.toolRunner) {
          tools.push(...runtime.toolRunner.listTools().map((t) => ({ type: t.type, description: t.description, params: t.params, capability: t.capability })));
        } else {
          tools.push(
            { type: "bash", description: "Run a shell command", params: { command: "string", cwd: "string", timeoutMs: "number" }, capability: "terminal" },
            { type: "file_read", description: "Read a file", params: { path: "string" }, capability: "filesystem" },
            { type: "file_write", description: "Write a file", params: { path: "string", content: "string" }, capability: "filesystem" },
            { type: "file_list", description: "List a directory", params: { path: "string" }, capability: "filesystem" },
            { type: "git", description: "Git operations (status/diff/commit/branch/log/push)", params: { operation: "string", message: "string", paths: "string[]" }, capability: "git" },
          );
        }
        sendJson(res, 200, { ok: true, data: tools });
        return;
      }

      if (req.method === "POST" && path === "/api/tools/execute") {
        const body = (await readBody(req)) as {
          tool?: string;
          config?: Record<string, unknown>;
          input?: Record<string, unknown>;
          permissions?: Record<string, unknown>;
        };
        if (typeof body.tool !== "string" || body.tool.length === 0) {
          sendJson(res, 400, { error: "tool is required" });
          return;
        }
        if (!runtime.toolRunner) {
          sendJson(res, 501, { error: "tool execution not available — no tool runner registered" });
          return;
        }
        const result = await runtime.toolRunner.execute({
          tool: body.tool,
          config: body.config,
          input: body.input,
          permissions: body.permissions as Record<string, "allow" | "deny" | "approval"> | undefined,
        });
        sendJson(res, result.ok ? 200 : 400, {
          ok: result.ok,
          output: result.output,
          artifact: result.artifact,
          status: result.status,
          durationMs: result.durationMs,
          approvalId: result.approvalId,
        });
        return;
      }

      const approvalResolveMatch = path.match(/^\/api\/tools\/approvals\/([^/]+)\/(accept|reject)$/);
      if (req.method === "POST" && approvalResolveMatch) {
        const [, approvalId, decision] = approvalResolveMatch;
        if (!runtime.toolRunner) {
          sendJson(res, 501, { error: "tool execution not available — no tool runner registered" });
          return;
        }
        const resolved = runtime.toolRunner.resolveApproval(approvalId, decision === "accept" ? "accepted" : "rejected");
        sendJson(res, resolved ? 200 : 404, { ok: resolved });
        return;
      }

      const browserSessionMatch = path.match(/^\/api\/browser\/([^/]+)$/);
      if (req.method === "GET" && browserSessionMatch) {
        const [, sessionId] = browserSessionMatch;
        if (!runtime.browserTool) {
          sendJson(res, 501, { error: "browser tool not available — Playwright not installed" });
          return;
        }
        const session = runtime.browserTool.getSession(sessionId);
        if (!session) {
          sendJson(res, 404, { error: `browser session not found: ${sessionId}` });
          return;
        }
        sendJson(res, 200, { ok: true, data: { id: session.id, createdAt: session.createdAt } });
        return;
      }

      const browserActionMatch = path.match(/^\/api\/browser\/([^/]+)\/action$/);
      if (req.method === "POST" && browserActionMatch) {
        const [, sessionId] = browserActionMatch;
        const body = (await readBody(req)) as { action?: string; url?: string; selector?: string };
        if (!runtime.browserTool) {
          sendJson(res, 501, { error: "browser tool not available — Playwright not installed" });
          return;
        }
        if (typeof body.action !== "string") {
          sendJson(res, 400, { error: "action is required" });
          return;
        }
        try {
          const result = await runtime.browserTool.action(
            {
              workspaceId: runtime.workspaceId,
              projectDir: runtime.projectDir,
              harnessRegistry: { get: () => undefined, set: () => {}, values: () => [] },
              capabilities: { agentId: "human", workspaceId: runtime.workspaceId, role: "human" },
            },
            {
              sessionId,
              action: body.action as "navigate" | "click" | "extract" | "screenshot",
              url: body.url,
              selector: body.selector,
            },
          );
          sendJson(res, 200, { ok: true, data: result });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendJson(res, 501, { error: message });
        }
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
