import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ArtifactType } from "../core/types.ts";
import type { ChefRuntime } from "../main.ts";

type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;
const ARTIFACT_TYPES: ArtifactType[] = ["file", "document", "code", "image", "research", "result"];

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

/**
 * Adds a workspace-scoped, read-only Artifact Library projection.
 *
 * Artifacts are already durable runtime entities. This wrapper makes them
 * independently inspectable without forcing clients to download the entire
 * workspace snapshot, while preserving the runtime/repository as authority.
 */
export function createArtifactServer(runtime: ChefRuntime, baseServer: Server): Server {
  const baseHandler = baseServer.listeners("request")[0] as RequestHandler | undefined;
  if (!baseHandler) throw new Error("base HTTP server has no request handler");

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
      if (req.method === "GET" && url.pathname === "/api/artifacts") {
        const requestedType = url.searchParams.get("type");
        if (requestedType && !ARTIFACT_TYPES.includes(requestedType as ArtifactType)) {
          sendJson(res, 400, { error: `type must be one of: ${ARTIFACT_TYPES.join(", ")}` });
          return;
        }
        const taskId = url.searchParams.get("taskId");
        const createdBy = url.searchParams.get("createdBy");
        const missionId = url.searchParams.get("missionId");
        let missionTaskIds: Set<string> | null = null;
        if (missionId) {
          const mission = runtime.repository.getMission(missionId);
          if (!mission || mission.workspaceId !== runtime.workspaceId) {
            sendJson(res, 404, { error: "mission not found" });
            return;
          }
          missionTaskIds = new Set(mission.taskIds);
        }
        const data = runtime.repository.listArtifacts(runtime.workspaceId).filter((artifact) =>
          (!requestedType || artifact.type === requestedType)
          && (!taskId || artifact.taskId === taskId)
          && (!createdBy || artifact.createdBy === createdBy)
          && (!missionTaskIds || Boolean(artifact.taskId && missionTaskIds.has(artifact.taskId))),
        );
        sendJson(res, 200, { ok: true, data });
        return;
      }

      const match = url.pathname.match(/^\/api\/artifacts\/([^/]+)$/);
      if (req.method === "GET" && match) {
        const artifact = runtime.repository.getArtifact(decodeURIComponent(match[1]));
        if (!artifact || artifact.workspaceId !== runtime.workspaceId) {
          sendJson(res, 404, { error: "artifact not found" });
          return;
        }
        sendJson(res, 200, { ok: true, data: artifact });
        return;
      }

      await baseHandler(req, res);
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}
