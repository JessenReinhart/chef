import { createHttpServer } from "./http-server.ts";
import { createContextScopeServer } from "./context-scope-http.ts";
import { createChef } from "../main.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "chef-server-"));
const dbPath = join(dir, "chef.sqlite");
const chef = createChef({ dbPath, projectDir: dir });
const port = Number(process.env.CHEF_PORT ?? 4321);

await chef.start();
const baseServer = createHttpServer(chef);
const server = createContextScopeServer(chef, baseServer);
server.listen(port, "127.0.0.1", () => {
  console.log(`chef inspector listening on http://127.0.0.1:${port}`);
  console.log(`  GET  /api/state    — workspace snapshot`);
  console.log(`  GET  /api/events   — live SSE event stream`);
  console.log(`  GET  /api/context-scopes — shared context scopes`);
  console.log(`  POST /api/sessions/send      { sessionId, data }`);
  console.log(`  POST /api/sessions/interrupt { sessionId }`);
  console.log(`  POST /api/sessions/resize    { sessionId, cols, rows }`);
});

const shutdown = async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await chef.close();
  rmSync(dir, { recursive: true, force: true });
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
