import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { ContextReference } from "../core/types.ts";
import type { ChefRuntime } from "../main.ts";
import { ContextScopeManager } from "../context/context-scope-manager.ts";

type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;

async function readBody(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) raw += Buffer.from(chunk).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

/** Adds durable context-scope routes without changing the existing inspector server. */
export function createContextScopeServer(runtime: ChefRuntime, baseServer: Server): Server {
  const baseHandler = baseServer.listeners("request")[0] as RequestHandler | undefined;
  if (!baseHandler) throw new Error("base HTTP server has no request handler");
  const scopes = new ContextScopeManager(join(runtime.projectDir, ".chef", "context-scopes.json"));
  const nodes = () => runtime.listCanvas(runtime.workspaceId).nodes;

  const syncContextRefs = async () => {
    const snapshot = await runtime.inspectState();
    const canvasNodes = nodes();
    for (const task of snapshot.tasks) {
      if (task.status !== "pending" && task.status !== "assigned") continue;
      const canvasNode = canvasNodes.find((n) => n.taskId === task.id || n.id === task.id);
      if (!canvasNode) continue;
      const scopedRefs = scopes.contextRefsForNode(runtime.workspaceId, canvasNode.id, canvasNodes);
      const existingRefs = runtime.repository.getTask(task.id)?.contextRefs ?? [];
      const merged = new Map(existingRefs.map((ref) => [`${ref.type}:${ref.id}`, ref]));
      for (const ref of scopedRefs) merged.set(`${ref.type}:${ref.id}`, ref);
      runtime.repository.updateTask(task.id, { contextRefs: [...merged.values()] });
    }
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
      if (req.method === "GET" && url.pathname === "/api/context-scopes") {
        sendJson(res, 200, { ok: true, data: scopes.list(runtime.workspaceId, nodes()) });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/context-scopes") {
        const body = await readBody(req) as {
          id?: string;
          name?: string;
          bounds?: { x: number; y: number; width: number; height: number };
          contextRefs?: ContextReference[];
        };
        if (!body.name || !body.bounds || Object.values(body.bounds).some((v) => typeof v !== "number" || !Number.isFinite(v))) {
          sendJson(res, 400, { error: "name and finite bounds are required" });
          return;
        }
        const scope = scopes.create({
          id: body.id,
          workspaceId: runtime.workspaceId,
          name: body.name,
          bounds: body.bounds,
          contextRefs: body.contextRefs ?? [],
        }, nodes());
        await syncContextRefs();
        sendJson(res, 201, { ok: true, data: scope });
        return;
      }

      const match = url.pathname.match(/^\/api\/context-scopes\/([^/]+)$/);
      if (match && req.method === "PATCH") {
        const body = await readBody(req) as {
          name?: string;
          bounds?: { x: number; y: number; width: number; height: number };
          contextRefs?: ContextReference[];
        };
        const scope = scopes.update(runtime.workspaceId, match[1], body, nodes());
        await syncContextRefs();
        sendJson(res, 200, { ok: true, data: scope });
        return;
      }
      if (match && req.method === "DELETE") {
        if (!scopes.delete(runtime.workspaceId, match[1])) {
          sendJson(res, 404, { error: "context scope not found" });
          return;
        }
        await syncContextRefs();
        sendJson(res, 200, { ok: true });
        return;
      }

      // The existing server owns dispatch. Refresh task context immediately before it runs.
      if (req.method === "POST" && url.pathname === "/api/dispatch") {
        await syncContextRefs();
        await baseHandler(req, res);
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/nodes/run") {
        const body = await readBody(req) as { nodeId?: string; assignedTo?: string };
        if (!body.nodeId) {
          sendJson(res, 400, { error: "nodeId is required" });
          return;
        }
        if (body.assignedTo) runtime.repository.updateTask(body.nodeId, { assignedTo: body.assignedTo });
        await syncContextRefs();
        await runtime.dispatchPending();
        sendJson(res, 200, { ok: true, data: { taskId: body.nodeId } });
        return;
      }
      await baseHandler(req, res);
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}
