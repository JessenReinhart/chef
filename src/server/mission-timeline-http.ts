import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Mission, RuntimeEvent } from "../core/types.ts";
import type { ChefRuntime } from "../main.ts";

type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

/**
 * Project the durable event stream into the history of one Mission.
 *
 * Events belong to a Mission when the runtime recorded that relationship
 * explicitly through the Mission source/payload, or when the event belongs to
 * one of the Mission's durable task ids. The original event records and seq
 * ordering are preserved for replay/audit UI.
 */
export function projectMissionTimeline(mission: Pick<Mission, "id" | "taskIds">, events: RuntimeEvent[]): RuntimeEvent[] {
  const taskIds = new Set(mission.taskIds);
  return events.filter((event) => {
    if (event.source.type === "mission" && event.source.id === mission.id) return true;
    if (event.taskId && taskIds.has(event.taskId)) return true;
    if (event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)) {
      return (event.payload as { missionId?: unknown }).missionId === mission.id;
    }
    return false;
  });
}

/** Adds a workspace-scoped, read-only Mission timeline projection. */
export function createMissionTimelineServer(runtime: ChefRuntime, baseServer: Server): Server {
  const baseHandler = baseServer.listeners("request")[0] as RequestHandler | undefined;
  if (!baseHandler) throw new Error("base HTTP server has no request handler");

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
      const match = url.pathname.match(/^\/api\/missions\/([^/]+)\/timeline$/);
      if (req.method === "GET" && match) {
        const missionId = decodeURIComponent(match[1]);
        const mission = runtime.repository.getMission(missionId);
        if (!mission || mission.workspaceId !== runtime.workspaceId) {
          sendJson(res, 404, { error: `mission not found: ${missionId}` });
          return;
        }
        const events = runtime.repository.listEvents(runtime.workspaceId);
        sendJson(res, 200, { ok: true, data: projectMissionTimeline(mission, events) });
        return;
      }

      await baseHandler(req, res);
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}
