import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, isAbsolute, relative, sep, win32 } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { ArtifactType } from "../core/types.ts";
import type { ChefRuntime } from "../main.ts";

const execFileAsync = promisify(execFile);
type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;
const ARTIFACT_TYPES: ArtifactType[] = ["file", "document", "code", "image", "research", "result"];

export interface ArtifactRevealCommand {
  command: string;
  args: string[];
}

export interface ArtifactServerOptions {
  revealPath?: (path: string, isDirectory: boolean) => Promise<void>;
}

class ArtifactLocationError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function isWithinRoot(rootPath: string, candidatePath: string): boolean {
  const rel = relative(rootPath, candidatePath);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function resolveArtifactLocation(runtime: ChefRuntime, artifactId: string) {
  const artifact = runtime.repository.getArtifact(artifactId);
  if (!artifact || artifact.workspaceId !== runtime.workspaceId) {
    throw new ArtifactLocationError(404, "artifact not found");
  }

  let artifactUrl: URL;
  try {
    artifactUrl = new URL(artifact.uri);
  } catch {
    throw new ArtifactLocationError(409, "artifact is not backed by a local file");
  }
  if (artifactUrl.protocol !== "file:") {
    throw new ArtifactLocationError(409, "artifact is not backed by a local file");
  }

  let uriPath: string;
  try {
    uriPath = fileURLToPath(artifactUrl);
  } catch {
    throw new ArtifactLocationError(409, "artifact has an invalid file URI");
  }

  let projectRoot: string;
  let filePath: string;
  try {
    projectRoot = await realpath(runtime.projectDir);
    filePath = await realpath(uriPath);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") throw new ArtifactLocationError(404, "artifact file not found");
    throw error;
  }

  if (!isWithinRoot(projectRoot, filePath)) {
    throw new ArtifactLocationError(403, "artifact file is outside the project root");
  }

  const info = await stat(filePath);
  return { artifact, filePath, isDirectory: info.isDirectory() };
}

export function artifactRevealCommand(
  filePath: string,
  isDirectory: boolean,
  platform: NodeJS.Platform = process.platform,
): ArtifactRevealCommand {
  const target = isDirectory
    ? filePath
    : platform === "win32"
      ? win32.dirname(filePath)
      : dirname(filePath);
  if (platform === "win32") return { command: "explorer.exe", args: [target] };
  if (platform === "linux") return { command: "xdg-open", args: [target] };
  throw new Error("showing artifact locations is not supported on this platform");
}

async function defaultRevealPath(filePath: string, isDirectory: boolean): Promise<void> {
  const reveal = artifactRevealCommand(filePath, isDirectory);
  await execFileAsync(reveal.command, reveal.args, process.platform === "win32" ? { windowsHide: true } : undefined);
}

async function sendArtifactDownload(runtime: ChefRuntime, artifactId: string, res: ServerResponse): Promise<void> {
  let location: Awaited<ReturnType<typeof resolveArtifactLocation>>;
  try {
    location = await resolveArtifactLocation(runtime, artifactId);
  } catch (error) {
    if (error instanceof ArtifactLocationError) {
      const message = error.message === "artifact is not backed by a local file"
        ? "artifact is not backed by a downloadable file"
        : error.message;
      sendJson(res, error.status, { error: message });
      return;
    }
    throw error;
  }

  if (location.isDirectory) {
    sendJson(res, 409, { error: "artifact URI does not point to a file" });
    return;
  }

  const metadataMimeType = location.artifact.metadata.mimeType;
  const contentType = typeof metadataMimeType === "string" && metadataMimeType.trim()
    ? metadataMimeType
    : "application/octet-stream";
  const info = await stat(location.filePath);
  const encodedName = encodeURIComponent(location.artifact.name || "artifact");
  res.writeHead(200, {
    "content-type": contentType,
    "content-length": info.size,
    "content-disposition": `attachment; filename*=UTF-8''${encodedName}`,
    "x-chef-artifact-id": location.artifact.id,
    "x-chef-artifact-version": String(location.artifact.version),
  });

  try {
    await pipeline(createReadStream(location.filePath), res);
  } catch (error) {
    res.destroy(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Adds a workspace-scoped, read-only Artifact Library projection plus an
 * explicit local reveal action for project-contained file-backed results.
 *
 * The reveal endpoint accepts only a durable artifact id. It resolves and
 * realpaths the stored URI server-side before invoking a shell-free OS opener,
 * so browser input can never choose an arbitrary filesystem path or command.
 */
export function createArtifactServer(runtime: ChefRuntime, baseServer: Server, options: ArtifactServerOptions = {}): Server {
  const baseHandler = baseServer.listeners("request")[0] as RequestHandler | undefined;
  if (!baseHandler) throw new Error("base HTTP server has no request handler");
  const revealPath = options.revealPath ?? defaultRevealPath;

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

      const revealMatch = url.pathname.match(/^\/api\/artifacts\/([^/]+)\/reveal$/);
      if (req.method === "POST" && revealMatch) {
        if (req.headers["x-chef-action"] !== "reveal-artifact") {
          sendJson(res, 403, { error: "explicit Chef reveal action is required" });
          return;
        }
        const artifactId = decodeURIComponent(revealMatch[1]);
        try {
          const location = await resolveArtifactLocation(runtime, artifactId);
          await revealPath(location.filePath, location.isDirectory);
          sendJson(res, 200, { ok: true, data: { artifactId, location: location.filePath } });
        } catch (error) {
          if (error instanceof ArtifactLocationError) {
            sendJson(res, error.status, { error: error.message });
            return;
          }
          throw error;
        }
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
