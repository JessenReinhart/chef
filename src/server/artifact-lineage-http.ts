import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Artifact, Task } from "../core/types.ts";
import type { ChefRuntime } from "../main.ts";

type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

export interface ArtifactLineage {
  artifact: Artifact;
  producerTask: Task | null;
  upstreamArtifacts: Artifact[];
  consumerTasks: Task[];
  downstreamArtifacts: Artifact[];
}

/** Build a conservative lineage projection from Chef's durable references. */
export function buildArtifactLineage(runtime: Pick<ChefRuntime, "workspaceId" | "repository">, artifact: Artifact): ArtifactLineage {
  const tasks = runtime.repository.listTasks(runtime.workspaceId);
  const artifacts = runtime.repository.listArtifacts(runtime.workspaceId);
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const artifactById = new Map(artifacts.map((candidate) => [candidate.id, candidate]));

  const producerTask = artifact.taskId ? taskById.get(artifact.taskId) ?? null : null;
  const upstreamIds = new Set(
    (producerTask?.contextRefs ?? [])
      .filter((ref) => ref.type === "artifact" && ref.id !== artifact.id)
      .map((ref) => ref.id),
  );
  const upstreamArtifacts = [...upstreamIds]
    .map((id) => artifactById.get(id))
    .filter((candidate): candidate is Artifact => candidate !== undefined);

  const consumerTasks = tasks.filter((task) =>
    task.id !== producerTask?.id
    && task.contextRefs.some((ref) => ref.type === "artifact" && ref.id === artifact.id),
  );
  const consumerTaskIds = new Set(consumerTasks.map((task) => task.id));
  const downstreamArtifacts = artifacts.filter((candidate) =>
    candidate.id !== artifact.id
    && candidate.taskId !== undefined
    && consumerTaskIds.has(candidate.taskId),
  );

  return { artifact, producerTask, upstreamArtifacts, consumerTasks, downstreamArtifacts };
}

/** Adds a workspace-scoped read-only artifact lineage endpoint. */
export function createArtifactLineageServer(runtime: ChefRuntime, baseServer: Server): Server {
  const baseHandler = baseServer.listeners("request")[0] as RequestHandler | undefined;
  if (!baseHandler) throw new Error("base HTTP server has no request handler");

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
      const match = url.pathname.match(/^\/api\/artifacts\/([^/]+)\/lineage$/);
      if (req.method === "GET" && match) {
        const artifact = runtime.repository.getArtifact(decodeURIComponent(match[1]));
        if (!artifact || artifact.workspaceId !== runtime.workspaceId) {
          sendJson(res, 404, { error: "artifact not found" });
          return;
        }
        sendJson(res, 200, { ok: true, data: buildArtifactLineage(runtime, artifact) });
        return;
      }

      await baseHandler(req, res);
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}
