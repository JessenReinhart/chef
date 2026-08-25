import { createHttpServer } from "./http-server.ts";
import { createContextScopeServer } from "./context-scope-http.ts";
import { createArtifactServer } from "./artifact-http.ts";
import { createMissionTimelineServer } from "./mission-timeline-http.ts";
import { createMissionPlanServer } from "./mission-plan-http.ts";
import { createMessageServer } from "./message-http.ts";
import { createArtifactLineageServer } from "./artifact-lineage-http.ts";
import { createDecisionServer } from "./decision-http.ts";
import { createHarnessReadinessServer } from "./harness-readiness-http.ts";
import { createBlockerServer } from "./blocker-http.ts";
import { createRecoveryServer } from "./recovery-http.ts";
import { createProjectServer } from "./project-http.ts";
import { createThreadServer } from "./thread-http.ts";
import { createOrchestratorConfigServer } from "./orchestrator-config-http.ts";
import { createWebUiServer } from "./web-ui-http.ts";
import { applyOrchestratorProviderEnv } from "./orchestrator-config.ts";
import { createMissionDecisionProvider } from "../orchestrator/fast-path-decision-provider.ts";
import { createChef } from "../main.ts";
import { mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

await applyOrchestratorProviderEnv();
const projectDir = resolve(process.env.CHEF_PROJECT_DIR ?? process.cwd());
const dbPath = resolve(process.env.CHEF_DB_PATH ?? join(projectDir, ".chef", "chef.sqlite"));
const chefRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const webDistDir = resolve(process.env.CHEF_WEB_DIST ?? join(chefRoot, "web", "dist"));
const missionTimeoutMs = process.env.CHEF_MISSION_TIMEOUT_MS
  ? Number(process.env.CHEF_MISSION_TIMEOUT_MS)
  : 4 * 60 * 60 * 1000;
if (!Number.isFinite(missionTimeoutMs) || missionTimeoutMs <= 0) {
  throw new Error(`CHEF_MISSION_TIMEOUT_MS must be a positive number (received ${process.env.CHEF_MISSION_TIMEOUT_MS})`);
}
mkdirSync(dirname(dbPath), { recursive: true });

// Chef's persisted orchestrator key must win during provider construction, but
// machine-level Anthropic/OpenAI env vars must remain intact for CLI workers.
const inheritedAnthropicKey = process.env.ANTHROPIC_API_KEY;
const inheritedOpenAIKey = process.env.OPENAI_API_KEY;
if (process.env.CHEF_PROVIDER && process.env.CHEF_API_KEY) {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
}
const missionDecisionProvider = createMissionDecisionProvider();
const chef = createChef({
  dbPath,
  projectDir,
  orchestratorTimeoutMs: missionTimeoutMs,
  decisionProvider: missionDecisionProvider ?? undefined,
});
if (inheritedAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
else process.env.ANTHROPIC_API_KEY = inheritedAnthropicKey;
if (inheritedOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
else process.env.OPENAI_API_KEY = inheritedOpenAIKey;

const port = Number(process.env.CHEF_PORT ?? 4321);
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error(`CHEF_PORT must be an integer between 0 and 65535 (received ${process.env.CHEF_PORT})`);
}

await chef.start();
const baseServer = createHttpServer(chef);
const contextServer = createContextScopeServer(chef, baseServer);
const artifactServer = createArtifactServer(chef, contextServer);
const timelineServer = createMissionTimelineServer(chef, artifactServer);
const planServer = createMissionPlanServer(chef, timelineServer);
const messageServer = createMessageServer(chef, planServer);
const lineageServer = createArtifactLineageServer(chef, messageServer);
const decisionServer = createDecisionServer(chef, lineageServer);
const readinessServer = createHarnessReadinessServer(chef, decisionServer);
const blockerServer = createBlockerServer(chef, readinessServer);
const recoveryServer = createRecoveryServer(chef, blockerServer);
const threadServer = createThreadServer(chef, recoveryServer);
let server: ReturnType<typeof createWebUiServer>;
let switchingProject = false;
const relaunch = async (nextProjectDir = projectDir) => {
  if (switchingProject) return;
  switchingProject = true;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  await chef.close();
  const env = { ...process.env, CHEF_PROJECT_DIR: nextProjectDir };
  delete env.CHEF_DB_PATH;
  delete env.CHEF_PROVIDER;
  delete env.CHEF_MODEL;
  delete env.CHEF_API_KEY;
  delete env.CHEF_BASE_URL;
  const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    cwd: nextProjectDir,
    detached: process.platform === "win32",
    env,
    stdio: "inherit",
  });
  child.unref();
  process.exit(0);
};
const projectServer = createProjectServer(chef, threadServer, { onOpenProject: relaunch });
const configuredServer = createOrchestratorConfigServer(projectServer, () => relaunch(projectDir));
server = createWebUiServer(configuredServer, { distDir: webDistDir });
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const listeningPort = typeof address === "object" && address ? address.port : port;
  console.log(`chef listening on http://127.0.0.1:${listeningPort}`);
  console.log(`  web client:        ${webDistDir}`);
  console.log(`  durable database:  ${dbPath}`);
  console.log(`  mission timeout:   ${missionTimeoutMs} ms`);
  console.log(`  GET  /api/state    — workspace snapshot`);
  console.log(`  GET  /api/events   — live SSE event stream`);
  console.log(`  GET  /api/context-scopes — shared context scopes`);
  console.log(`  GET  /api/artifacts — durable artifact library`);
  console.log(`  GET  /api/artifacts/:id/lineage — explicit artifact lineage`);
  console.log(`  GET  /api/decisions — durable Decision Library`);
  console.log(`  GET  /api/missions/:id/timeline — Mission event history`);
  console.log(`  GET  /api/missions/:id/plans — Mission plan history`);
  console.log(`  GET  /api/messages — structured collaboration messages`);
  console.log(`  GET  /api/harnesses/readiness — detected CLI harness readiness`);
  console.log(`  GET  /api/blockers — pending approvals and blocked/failed tasks`);
  console.log(`  POST /api/nodes/:id/retry — retry failed/blocked work`);
  console.log(`  GET/POST /api/threads — durable conversation threads`);
  console.log(`  GET/PATCH /api/threads/:id — inspect or rename/update a Thread`);
  console.log(`  POST /api/threads/:id/archive — archive a Thread`);
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
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  await chef.close();
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());