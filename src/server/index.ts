import { createHttpServer } from "./http-server.ts";
import { createContextScopeServer } from "./context-scope-http.ts";
import { createArtifactServer } from "./artifact-http.ts";
import { createProjectServer } from "./project-http.ts";
import { createOrchestratorConfigServer } from "./orchestrator-config-http.ts";
import { applyOrchestratorProviderEnv } from "./orchestrator-config.ts";
import { createChef } from "../main.ts";
import { mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";

await applyOrchestratorProviderEnv();
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
const contextServer = createContextScopeServer(chef, baseServer);
const artifactServer = createArtifactServer(chef, contextServer);
let server: ReturnType<typeof createProjectServer>;
let switchingProject = false;
const relaunch = async (nextProjectDir = projectDir) => {
  if (switchingProject) return;
  switchingProject = true;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  await chef.close();
  const env = { ...process.env, CHEF_PROJECT_DIR: nextProjectDir };
  delete env.CHEF_DB_PATH;
  delete env.CHEF_PROVIDER; delete env.CHEF_MODEL; delete env.CHEF_API_KEY; delete env.CHEF_BASE_URL;
  const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], { cwd: nextProjectDir, detached: process.platform === "win32", env, stdio: "inherit" });
  child.unref();
  process.exit(0);
};
const projectServer = createProjectServer(chef, artifactServer, {
  onOpenProject: relaunch,
});
server = createOrchestratorConfigServer(projectServer, () => relaunch(projectDir));
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const listeningPort = typeof address === "object" && address ? address.port : port;
  console.log(`chef inspector listening on http://127.0.0.1:${listeningPort}`);
  console.log(`  durable database: ${dbPath}`);
  console.log(`  GET  /api/state    — workspace snapshot`);
  console.log(`  GET  /api/events   — live SSE event stream`);
  console.log(`  GET  /api/context-scopes — shared context scopes`);
  console.log(`  GET  /api/artifacts — durable artifact library`);
  console.log(`  GET  /api/project   — active project + recent projects`);
  console.log(`  POST /api/project/pick — native Windows folder picker + runtime reopen`);
  console.log(`  GET/PUT /api/orchestrator/provider — orchestrator direct LLM settings`);
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
