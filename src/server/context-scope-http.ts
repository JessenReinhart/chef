import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ContextReference } from "../core/types.ts";
import type { ChefRuntime } from "../main.ts";

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
  const nodes = () => runtime.listCanvas(runtime.workspaceId).nodes;

  const invalidMembers = (memberNodeIds: string[]): string[] => {
    const validIds = new Set(nodes().filter((node) => node.workspaceId === runtime.workspaceId).map((node) => node.id));
    return [...new Set(memberNodeIds)].filter((nodeId) => !validIds.has(nodeId));
  };

  const invalidBounds = (bounds: { x: number; y: number; width: number; height: number }): boolean =>
    Object.values(bounds).some((value) => typeof value !== "number" || !Number.isFinite(value));

  const syncContextRefs = async () => {
    const snapshot = await runtime.inspectState();
    const canvasNodes = nodes();
    const scopes = runtime.repository.listContextZones(runtime.workspaceId);
    const tasksById = new Map(snapshot.tasks.map((task) => [task.id, task]));
    const nodesById = new Map(canvasNodes.map((node) => [node.id, node]));
    const assignments = scopes.flatMap((scope) => scope.memberNodeIds.flatMap((nodeId) => {
      const node = nodesById.get(nodeId);
      const task = node?.taskId ? tasksById.get(node.taskId) : tasksById.get(nodeId);
      if (!task || (task.status !== "pending" && task.status !== "assigned")) return [];
      return [{ zoneId: scope.id, taskId: task.id, contextRefs: scope.contextRefs }];
    }));
    runtime.repository.syncContextZoneRefs(runtime.workspaceId, assignments);
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
      if (req.method === "GET" && url.pathname === "/api/context-scopes") {
        sendJson(res, 200, { ok: true, data: runtime.repository.listContextZones(runtime.workspaceId) });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/context-scopes") {
        const body = await readBody(req) as {
          id?: string;
          name?: string;
          bounds?: { x: number; y: number; width: number; height: number };
          contextRefs?: ContextReference[];
          memberNodeIds?: string[];
          policy?: Record<string, unknown>;
        };
        if (!body.name || !body.bounds || invalidBounds(body.bounds)) {
          sendJson(res, 400, { error: "name and finite bounds are required" });
          return;
        }
        const memberNodeIds = body.memberNodeIds ?? [];
        const invalid = invalidMembers(memberNodeIds);
        if (invalid.length > 0) {
          sendJson(res, 400, { error: `memberNodeIds must reference canvas nodes in this workspace: ${invalid.join(", ")}` });
          return;
        }
        const scope = runtime.repository.upsertContextZone({
          id: body.id,
          workspaceId: runtime.workspaceId,
          name: body.name,
          bounds: body.bounds,
          contextRefs: body.contextRefs ?? [],
          memberNodeIds,
          policy: body.policy,
        });
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
          memberNodeIds?: string[];
          policy?: Record<string, unknown>;
        };
        const current = runtime.repository.getContextZone(match[1]);
        if (!current || current.workspaceId !== runtime.workspaceId) { sendJson(res, 404, { error: "context scope not found" }); return; }
        if (body.bounds && invalidBounds(body.bounds)) {
          sendJson(res, 400, { error: "bounds must be finite numbers" });
          return;
        }
        const memberNodeIds = body.memberNodeIds ?? current.memberNodeIds;
        const invalid = invalidMembers(memberNodeIds);
        if (invalid.length > 0) {
          sendJson(res, 400, { error: `memberNodeIds must reference canvas nodes in this workspace: ${invalid.join(", ")}` });
          return;
        }
        const scope = runtime.repository.upsertContextZone({
          id: current.id, workspaceId: current.workspaceId, name: body.name ?? current.name,
          bounds: body.bounds ?? current.bounds, contextRefs: body.contextRefs ?? current.contextRefs,
          memberNodeIds, policy: body.policy ?? current.policy,
        });
        await syncContextRefs();
        sendJson(res, 200, { ok: true, data: scope });
        return;
      }
      if (match && req.method === "DELETE") {
        const current = runtime.repository.getContextZone(match[1]);
        if (!current || current.workspaceId !== runtime.workspaceId || !runtime.repository.deleteContextZone(match[1])) {
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
