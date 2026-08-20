import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { loadOrchestratorProviderSettings, saveOrchestratorProviderSettings } from "./orchestrator-config.ts";

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
const headers = { "content-type": "application/json; charset=utf-8" } as const;
const send = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, headers); res.end(JSON.stringify(body)); };
const body = (req: IncomingMessage) => new Promise<unknown>((resolve, reject) => {
  let raw = ""; req.on("data", (chunk: Buffer) => { raw += chunk.toString("utf8"); });
  req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (error) { reject(error); } }); req.on("error", reject);
});

export function createOrchestratorConfigServer(baseServer: Server, onSaved: () => void | Promise<void>): Server {
  const baseHandler = baseServer.listeners("request")[0] as Handler | undefined;
  if (!baseHandler) throw new Error("base HTTP server has no request handler");
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
      if (req.method === "GET" && url.pathname === "/api/orchestrator/provider") {
        const { settings } = await loadOrchestratorProviderSettings();
        send(res, 200, { ok: true, data: settings }); return;
      }
      if (req.method === "PUT" && url.pathname === "/api/orchestrator/provider") {
        const input = await body(req) as { provider?: unknown; model?: unknown; baseUrl?: unknown; apiKey?: unknown };
        if (typeof input.provider !== "string" || typeof input.model !== "string") { send(res, 400, { error: "provider and model are required" }); return; }
        const settings = await saveOrchestratorProviderSettings({
          provider: input.provider,
          model: input.model,
          baseUrl: typeof input.baseUrl === "string" ? input.baseUrl : undefined,
          apiKey: typeof input.apiKey === "string" ? input.apiKey : undefined,
        });
        send(res, 202, { ok: true, data: { ...settings, reopening: true } });
        setTimeout(() => { void onSaved(); }, 100);
        return;
      }
      await baseHandler(req, res);
    } catch (error) {
      send(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}
