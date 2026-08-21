import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Decision, DecisionStatus } from "../core/types.ts";
import type { ChefRuntime } from "../main.ts";

type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
type MemoryCategory = "decisions" | "requirements" | "knownFacts" | "conventions" | "lessons" | "openQuestions" | "reusableProcedures";
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;
const DECISION_STATUSES: DecisionStatus[] = ["proposed", "accepted", "rejected"];
const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const MAX_TYPE_LENGTH = 80;
const MAX_SUMMARY_LENGTH = 2_000;
const MEMORY_CATEGORIES: MemoryCategory[] = [
  "decisions",
  "requirements",
  "knownFacts",
  "conventions",
  "lessons",
  "openQuestions",
  "reusableProcedures",
];

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_REQUEST_BODY_BYTES) throw new Error("request body too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function memoryCategoryFor(type: string): MemoryCategory {
  const normalized = type.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (normalized === "requirement" || normalized === "requirements") return "requirements";
  if (["fact", "facts", "knownfact", "knownfacts"].includes(normalized)) return "knownFacts";
  if (normalized === "convention" || normalized === "conventions") return "conventions";
  if (normalized === "lesson" || normalized === "lessons") return "lessons";
  if (["question", "questions", "openquestion", "openquestions"].includes(normalized)) return "openQuestions";
  if (["procedure", "procedures", "reusableprocedure", "reusableprocedures"].includes(normalized)) return "reusableProcedures";
  return "decisions";
}

function buildMemoryProjection(decisions: Decision[]) {
  const categories = Object.fromEntries(MEMORY_CATEGORIES.map((category) => [category, [] as Decision[]])) as Record<MemoryCategory, Decision[]>;

  for (const decision of decisions) {
    const category = memoryCategoryFor(decision.type);
    const include = category === "openQuestions"
      ? decision.status === "proposed"
      : category === "decisions"
        ? decision.status !== "proposed"
        : decision.status === "accepted";
    if (include) categories[category].push(decision);
  }

  return {
    categories,
    counts: Object.fromEntries(MEMORY_CATEGORIES.map((category) => [category, categories[category].length])) as Record<MemoryCategory, number>,
  };
}

/** Adds workspace-scoped Decision Library and project-memory read/write projections. */
export function createDecisionServer(runtime: ChefRuntime, baseServer: Server): Server {
  const baseHandler = baseServer.listeners("request")[0] as RequestHandler | undefined;
  if (!baseHandler) throw new Error("base HTTP server has no request handler");

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
      if (req.method === "GET" && url.pathname === "/api/memory") {
        const decisions = runtime.repository.listDecisions(runtime.workspaceId);
        sendJson(res, 200, { ok: true, data: buildMemoryProjection(decisions) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/decisions") {
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch (error) {
          if (error instanceof Error && error.message === "request body too large") {
            sendJson(res, 413, { error: `request body must be at most ${MAX_REQUEST_BODY_BYTES} bytes` });
          } else {
            sendJson(res, 400, { error: "request body must be valid JSON" });
          }
          return;
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          sendJson(res, 400, { error: "request body must be an object" });
          return;
        }

        const input = body as Record<string, unknown>;
        const type = typeof input.type === "string" ? input.type.trim() : "";
        const summary = typeof input.summary === "string" ? input.summary.trim() : "";
        const requestedStatus = typeof input.status === "string" ? input.status.trim() : undefined;
        if (!type) {
          sendJson(res, 400, { error: "type is required" });
          return;
        }
        if (type.length > MAX_TYPE_LENGTH) {
          sendJson(res, 400, { error: `type must be at most ${MAX_TYPE_LENGTH} characters` });
          return;
        }
        if (!summary) {
          sendJson(res, 400, { error: "summary is required" });
          return;
        }
        if (summary.length > MAX_SUMMARY_LENGTH) {
          sendJson(res, 400, { error: `summary must be at most ${MAX_SUMMARY_LENGTH} characters` });
          return;
        }
        if (requestedStatus && !DECISION_STATUSES.includes(requestedStatus as DecisionStatus)) {
          sendJson(res, 400, { error: `status must be one of: ${DECISION_STATUSES.join(", ")}` });
          return;
        }

        const category = memoryCategoryFor(type);
        const status = (requestedStatus as DecisionStatus | undefined) ?? (category === "openQuestions" ? "proposed" : "accepted");
        const decision = runtime.repository.transaction(() => {
          const created = runtime.repository.insertDecision({
            id: randomUUID(),
            workspaceId: runtime.workspaceId,
            type,
            summary,
            payload: input.payload ?? {},
            madeBy: "human",
            timestamp: Date.now(),
            status,
          });
          runtime.repository.appendEvent({
            workspaceId: runtime.workspaceId,
            source: { type: "human", id: "human" },
            type: "memory.recorded",
            payload: { decisionId: created.id, type: created.type, status: created.status, category },
          });
          return created;
        });
        sendJson(res, 201, { ok: true, data: decision });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/decisions") {
        const status = url.searchParams.get("status");
        if (status && !DECISION_STATUSES.includes(status as DecisionStatus)) {
          sendJson(res, 400, { error: `status must be one of: ${DECISION_STATUSES.join(", ")}` });
          return;
        }
        const type = url.searchParams.get("type");
        const madeBy = url.searchParams.get("madeBy");
        const data = runtime.repository.listDecisions(runtime.workspaceId).filter((decision) =>
          (!status || decision.status === status)
          && (!type || decision.type === type)
          && (!madeBy || decision.madeBy === madeBy),
        );
        sendJson(res, 200, { ok: true, data });
        return;
      }

      const match = url.pathname.match(/^\/api\/decisions\/([^/]+)$/);
      if (req.method === "GET" && match) {
        const decision = runtime.repository.getDecision(decodeURIComponent(match[1]));
        if (!decision || decision.workspaceId !== runtime.workspaceId) {
          sendJson(res, 404, { error: "decision not found" });
          return;
        }
        sendJson(res, 200, { ok: true, data: decision });
        return;
      }

      await baseHandler(req, res);
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}
