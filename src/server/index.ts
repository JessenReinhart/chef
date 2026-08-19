import { createHttpServer } from "./http-server.ts";
import { createContextScopeServer } from "./context-scope-http.ts";
import { createChef } from "../main.ts";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const projectDir = resolve(process.env.CHEF_PROJECT_DIR ?? process.cwd());
const dbPath = resolve(process.env.CHEF_DB_PATH ?? join(projectDir, ".chef", "chef.sqlite"));
mkdirSync(dirname(dbPath), { recursive: true });
const chef = createChef({ dbPath, projectDir });
const port = Number(process.env.CHEF_PORT ?? 4321);
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error(`CHEF_PORT must be an integer between 0 and 65535 (received ${process.env.CHEF_PORT})`);
}

await chef.start();
const baseServer = createHttpServer(chef);
const server = createContextScopeServer(chef, baseServer);
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const listeningPort = typeof address === "object" && address ? address.port : port;
  console.log(`chef inspector listening on http://127.0.0.1:${listeningPort}`);
  console.log(`  durable database: ${dbPath}`);
  console.log(`  GET  /api/state    — workspace snapshot`);
  console.log(`  GET  /api/events   — live SSE event stream`);
  console.log(`  GET  /api/context-scopes — shared context scopes`);
  console.log(`  POST /api/sessions/send      { sessionId, data }`);
  console.log(`  POST /api/sessions/interrupt { sessionId }`);
  console.log(`  POST /api/sessions/resize    { sessionId, cols, rows }`);
});

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await chef.close();
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
