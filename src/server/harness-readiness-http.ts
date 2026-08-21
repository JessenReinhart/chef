import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ChefRuntime } from "../main.ts";
import type { HarnessDetection } from "../runtime/harness-registry.ts";

type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;

export interface HarnessReadiness extends HarnessDetection {
  kind: "cli";
}

export interface GenericHarnessReadiness {
  id: "generic";
  name: "Generic Terminal";
  type: "generic";
  command: null;
  available: true;
  kind: "generic";
}

export type HarnessReadinessItem = HarnessReadiness | GenericHarnessReadiness;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

export function buildHarnessReadiness(detections: HarnessDetection[]): HarnessReadinessItem[] {
  return [
    ...detections.map((detection) => ({ ...detection, kind: "cli" as const })),
    {
      id: "generic",
      name: "Generic Terminal",
      type: "generic",
      command: null,
      available: true,
      kind: "generic",
    },
  ];
}

/** Read-only setup/readiness projection over the runtime's retained harness discovery snapshot. */
export function createHarnessReadinessServer(runtime: ChefRuntime, baseServer: Server): Server {
  const baseHandler = baseServer.listeners("request")[0] as RequestHandler | undefined;
  if (!baseHandler) throw new Error("base HTTP server has no request handler");

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
      if (req.method === "GET" && url.pathname === "/api/harnesses/readiness") {
        const data = buildHarnessReadiness(runtime.specializedHarnesses.detections());
        sendJson(res, 200, { ok: true, data });
        return;
      }

      await baseHandler(req, res);
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}
