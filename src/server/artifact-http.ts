import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isAbsolute, relative, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import type { ArtifactType } from "../core/types.ts";
import type { ChefRuntime } from "../main.ts";

type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;
const ARTIFACT_TYPES: ArtifactType[] = ["file", "document", "code", "image", "research", "result"];

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function isWithinRoot(rootPath: string, candidatePath: string): boolean {
  const rel = relative(rootPath, candidatePath);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function sendArtifactDownload(runtime: ChefRuntime, artifactId: string, res: ServerResponse): Promise<void> {
  const artifact = runtime.repository.getArtifact(artifactId);
  if (!artifact || artifact.workspaceId !== runtime.workspaceId) {
    sendJson(res, 404, { error: "artifact not found" });
    return;
  }

  let artifactUrl: URL;
  try {
    artifactUrl = new URL(artifact.uri);
  } catch {
    sendJson(res, 409, { error: "artifact is not backed by a downloadable file" });
    return;
  }
  if (artifactUrl.protocol !== "file:") {
    sendJson(res, 409, { error: "artifact is not backed by a downloadable file" });
    return;
  }

  let uriPath: string;
  try {
    uriPath = fileURLToPath(artifactUrl);
  } catch {
    sendJson(res, 409, { error: "artifact has an invalid file URI" });
    return;
  }

  let projectRoot: string;
  let filePath: string;
  try {
    projectRoot = await realpath(runtime.projectDir);
    filePath = await realpath(uriPath);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") {
      sendJson(res, 404, { error: "artifact file not found" });
      return;
    }
    throw error;
  }

  if (!isWithinRoot(projectRoot, filePath)) {
    sendJson(res, 403, { error: "artifact file is outside the project root" });
    return;
  }

  const info = await stat(filePath);
  if (!info.isFile()) {
    sendJson(res, 409, { error: "artifact URI does not point to a file" });
    return;
  }

  const metadataMimeType = artifact.metadata.mimeType;
  const contentType = typeof metadataMimeType === "string" && metadataMimeType.trim()
    ? metadataMimeType
    : "application/octet-stream";
  const encodedName = encodeURIComponent(artifact.name || "artifact");
  res.writeHead(200, {
    "content-type": contentType,
    "content-length": info.size,
    "content-disposition": `attachment; filename*=UTF-8''${encodedName}`,
    "x-chef-artifact-id": artifact.id,
    "x-chef-artifact-version": String(artifact.version),
  });

  try {
    await pipeline(createReadStream(filePath), res);
  } catch (error) {
    res.destroy(error instanceof Error ? error : new Error(String(error)));
  }
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

      const downloadMatch = url.pathname.match(/^\/api\/artifacts\/([^/]+)\/download$/);
      if (req.method === "GET" && downloadMatch) {
        await sendArtifactDownload(runtime, decodeURIComponent(downloadMatch[1]), res);
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
      if (!res.headersSent) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      } else {
        res.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });
}
