import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Decision, DecisionStatus } from "../core/types.ts";
import type { ChefRuntime } from "../main.ts";

type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
type MemoryCategory = "decisions" | "requirements" | "knownFacts" | "conventions" | "lessons" | "openQuestions" | "reusableProcedures";
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;
const DECISION_STATUSES: DecisionStatus[] = ["proposed", "accepted", "rejected"];
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

/** Adds workspace-scoped, read-only Decision Library and project-memory projections. */
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
