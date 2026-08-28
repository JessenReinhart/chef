import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { RuntimeEvent } from "../src/core/types.ts";
import { createChef, type ChefRuntime } from "../src/main.ts";
import { applyOrchestratorProviderEnv } from "../src/server/orchestrator-config.ts";
import { createHttpServer } from "../src/server/http-server.ts";
import { createThreadServer } from "../src/server/thread-http.ts";

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_STARTUP_BUDGET_MS = 5_000;
const MAX_PROGRESS_TRACE = 20;

function isMeaningfulProgress(event: RuntimeEvent): boolean {
  return event.type.startsWith("mission.") || event.type.startsWith("task.") || event.type.startsWith("session.");
}

function formatProgressTrace(events: readonly RuntimeEvent[]): string {
  if (events.length === 0) return "(no Mission/Task/Session progress events observed)";
  return events
    .slice(-MAX_PROGRESS_TRACE)
    .map((event) => `${event.seq} ${event.type}${event.taskId ? ` task=${event.taskId}` : ""}${event.sessionId ? ` session=${event.sessionId}` : ""}`)
    .join("\n");
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function stopProcessTree(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || !child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    await new Promise<void>((resolve) => killer.once("exit", () => resolve()));
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child!.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForHttp(url: string, child: ChildProcess, timeoutMs = 20_000): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Generated app exited before becoming ready (exit ${child.exitCode})`);
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Generated app did not become reachable: ${String(lastError)}`);
}

async function waitForFreshWorkerSession(
  chef: ChefRuntime,
  workerIds: ReadonlySet<string>,
  existingSessionIds: ReadonlySet<string>,
  missionId: string,
  budgetMs: number,
): Promise<{ id: string; taskId: string; agentId: string }> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const snapshot = await chef.inspectState();
    const missionTaskIds = new Set(snapshot.tasks.filter((task) => task.missionId === missionId).map((task) => task.id));
    const session = snapshot.sessions.find(
      (candidate) => workerIds.has(candidate.agentId) && !existingSessionIds.has(candidate.id) && missionTaskIds.has(candidate.taskId),
    );
    if (session) return { id: session.id, taskId: session.taskId, agentId: session.agentId };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`No new detected task-capable CLI worker Session started within ${budgetMs}ms`);
}

async function waitForMissionCompletion(chef: ChefRuntime, missionId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const mission = chef.repository.getMission(missionId);
    if (mission?.status === "completed") return;
    if (mission && ["failed", "cancelled"].includes(mission.status)) {
      throw new Error(`Canonical todo Mission ended as ${mission.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Canonical todo Mission did not complete within ${timeoutMs}ms`);
}

async function waitForAssistantResult(origin: string, threadId: string, missionId: string, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${origin}/api/threads/${encodeURIComponent(threadId)}/messages`);
    if (response.ok) {
      const body = await response.json() as { data?: Array<{ role?: string; content?: string; metadata?: { missionId?: string; ok?: boolean } }> };
      const assistant = body.data?.find((message) => message.role === "assistant" && message.metadata?.missionId === missionId);
      if (assistant?.content) {
        assert.equal(assistant.metadata?.ok, true, assistant.content);
        return assistant.content;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Completed Mission did not publish its final assistant result back into the selected Thread");
}

async function main(): Promise<void> {
  const timeoutMs = Number(process.env.CHEF_E2E_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const startupBudgetMs = Number(process.env.CHEF_LIVE_STARTUP_BUDGET_MS ?? DEFAULT_STARTUP_BUDGET_MS);
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0, "CHEF_E2E_TIMEOUT_MS must be a positive number");
  assert.ok(Number.isFinite(startupBudgetMs) && startupBudgetMs > 0, "CHEF_LIVE_STARTUP_BUDGET_MS must be a positive number");

  await applyOrchestratorProviderEnv();

  const projectDir = await mkdtemp(join(tmpdir(), "chef-todo-acceptance-"));
  const dbPath = join(projectDir, "chef.sqlite");
  let chef: ChefRuntime | undefined;
  let apiServer: Server | undefined;
  let app: ChildProcess | undefined;
  let unsubscribeEvents: (() => void) | undefined;
  let passed = false;
  const progressEvents: RuntimeEvent[] = [];
  const postAckProgressEvents: RuntimeEvent[] = [];
  let acknowledged = false;

  try {
    chef = createChef({ dbPath, projectDir, orchestratorTimeoutMs: timeoutMs });
    await chef.start();

    const workers = chef.specializedHarnesses.detections().filter((worker) => worker.available && worker.taskCapable);
    assert.equal(
      chef.llmStatus.configured,
      true,
      "Chef must have a real configured planner. Configure Chef normally or set CHEF_PROVIDER plus its API key.",
    );
    assert.ok(workers.length > 0, "At least one real task-capable worker must be detected");
    const workerIds = new Set(workers.map((worker) => worker.id));
    const beforeExecution = await chef.inspectState();
    const existingSessionIds = new Set(beforeExecution.sessions.map((session) => session.id));

    apiServer = createThreadServer(chef, createHttpServer(chef));
    await new Promise<void>((resolve, reject) => {
      apiServer!.once("error", reject);
      apiServer!.listen(0, "127.0.0.1", resolve);
    });
    const apiPort = (apiServer.address() as AddressInfo).port;
    const origin = `http://127.0.0.1:${apiPort}`;

    unsubscribeEvents = chef.subscribeEvents((event) => {
      if (!isMeaningfulProgress(event)) return;
      progressEvents.push(event);
      if (acknowledged) postAckProgressEvents.push(event);
    });

    const createThreadResponse = await fetch(`${origin}/api/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Live todo acceptance" }),
    });
    assert.equal(createThreadResponse.status, 201, "Live acceptance must create a Thread through the product HTTP boundary");
    const createdThread = await createThreadResponse.json() as { data?: { id?: string } };
    const threadId = createdThread.data?.id;
    assert.ok(threadId, "Created Thread must expose an id");

    const request = "Create a todo app in this selected project using only Node.js built-ins and browser HTML/CSS/JavaScript, with package.json npm start, PORT support, and add/complete/remove controls. Verify it starts and summarize how to run it.";
    const response = await fetch(`${origin}/api/threads/${encodeURIComponent(threadId)}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: request }),
      signal: AbortSignal.timeout(Math.min(timeoutMs, 10_000)),
    });
    const body = await response.json() as { ok?: boolean; data?: { ok?: boolean; accepted?: boolean; missionId?: string; threadId?: string }; error?: string };
    assert.equal(response.status, 202, `Chef Thread chat acknowledgement failed: ${JSON.stringify(body)}`);
    assert.equal(body.ok, true, body.error ?? "Chef did not accept the canonical todo request");
    assert.equal(body.data?.ok, true);
    assert.equal(body.data?.accepted, true);
    assert.equal(body.data?.threadId, threadId);
    const missionId = body.data?.missionId;
    assert.ok(missionId, "Immediate acknowledgement must expose durable Mission lineage");
    acknowledged = true;

    const startedSession = await waitForFreshWorkerSession(chef, workerIds, existingSessionIds, missionId, startupBudgetMs);
    assert.ok(
      postAckProgressEvents.length > 0,
      `Chef produced no Mission/Task/Session progress after acknowledgement. Recent progress trace:\n${formatProgressTrace(progressEvents)}`,
    );

    await waitForMissionCompletion(chef, missionId, timeoutMs);
    const report = await waitForAssistantResult(origin, threadId, missionId);

    const snapshot = await chef.inspectState();
    const missionTasks = snapshot.tasks.filter((task) => task.missionId === missionId);
    const taskIds = new Set(missionTasks.map((task) => task.id));
    const missionSessions = snapshot.sessions.filter((session) => taskIds.has(session.taskId));
    const singleWorkerRoutingEvent = snapshot.events.find((event) => {
      if (event.type !== "orchestrator.plan.proposed" || !event.payload || typeof event.payload !== "object") return false;
      return (event.payload as { routingMode?: unknown; missionId?: unknown }).routingMode === "single-worker"
        && (event.payload as { missionId?: unknown }).missionId === missionId;
    });

    assert.ok(singleWorkerRoutingEvent, "Canonical todo request must durably record the single-worker route instead of paying a planner round-trip");
    assert.ok(missionTasks.length > 0, "Canonical todo Mission must create at least one real Task");
    assert.ok(taskIds.has(startedSession.taskId), "Observed fresh CLI Session must belong to the acknowledged Mission");
    assert.ok(missionTasks.every((task) => task.status === "completed"), "Every Mission task must complete");
    assert.ok(missionSessions.some((session) => session.id === startedSession.id), "The bounded startup Session must remain in durable Mission state");
    assert.ok(missionSessions.every((session) => session.status === "completed"), "Every Mission worker session must terminate successfully");
    assert.ok(snapshot.events.some((event) => event.type === "task.completed" && taskIds.has(event.taskId ?? "")), "Runtime must record Mission task completion");

    await stat(join(projectDir, "package.json"));
    const packageJson = JSON.parse(await readFile(join(projectDir, "package.json"), "utf8")) as { scripts?: { start?: string } };
    assert.ok(packageJson.scripts?.start, "Generated app must expose npm start");

    const appPort = await freePort();
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    app = spawn(npm, ["start"], {
      cwd: projectDir,
      env: { ...process.env, PORT: String(appPort) },
      stdio: "ignore",
    });

    const appResponse = await waitForHttp(`http://127.0.0.1:${appPort}/`, app);
    const html = await appResponse.text();
    assert.ok(/todo/i.test(html), "Generated app root must visibly identify itself as a todo app");

    passed = true;
    console.log(`live-todo-acceptance: ok (${chef.llmStatus.provider}/${chef.llmStatus.model}; worker: ${startedSession.agentId}; candidates: ${workers.map((worker) => worker.id).join(", ")})`);
    console.log(`Thread: ${threadId}; Mission: ${missionId}`);
    console.log(`Worker startup: session=${startedSession.id} task=${startedSession.taskId} within ${startupBudgetMs}ms budget.`);
    console.log("Routing: single-worker (durable orchestrator.plan.proposed evidence).");
    console.log(`Observed ${postAckProgressEvents.length} post-ack Mission/Task/Session progress events.`);
    console.log(`Chef summary: ${report}`);
  } finally {
    acknowledged = true;
    unsubscribeEvents?.();
    if (!passed) console.error(`Recent Chef progress trace:\n${formatProgressTrace(progressEvents)}`);
    await stopProcessTree(app);
    await closeServer(apiServer);
    if (chef) await chef.close();
    if (passed && process.env.CHEF_E2E_KEEP_PROJECT !== "1") {
      await rm(projectDir, { recursive: true, force: true });
    } else {
      console.error(`live-todo-acceptance fixture preserved at: ${projectDir}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error("live-todo-acceptance: FAILED", error);
  process.exitCode = 1;
});
