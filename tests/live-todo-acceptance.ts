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
  budgetMs: number,
): Promise<{ id: string; taskId: string; agentId: string }> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const snapshot = await chef.inspectState();
    const session = snapshot.sessions.find(
      (candidate) => workerIds.has(candidate.agentId) && !existingSessionIds.has(candidate.id),
    );
    if (session) return { id: session.id, taskId: session.taskId, agentId: session.agentId };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`No new detected task-capable CLI worker Session started within ${budgetMs}ms`);
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
  let chatAbort: AbortController | undefined;
  let passed = false;
  let requestCompleted = false;
  const progressEvents: RuntimeEvent[] = [];
  const inFlightProgressEvents: RuntimeEvent[] = [];

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

    unsubscribeEvents = chef.subscribeEvents((event) => {
      if (!isMeaningfulProgress(event)) return;
      progressEvents.push(event);
      if (!requestCompleted) inFlightProgressEvents.push(event);
    });

    const createThreadResponse = await fetch(`http://127.0.0.1:${apiPort}/api/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Live todo acceptance" }),
    });
    assert.equal(createThreadResponse.status, 201, "Live acceptance must create a Thread through the product HTTP boundary");
    const createdThread = await createThreadResponse.json() as { data?: { id?: string } };
    const threadId = createdThread.data?.id;
    assert.ok(threadId, "Created Thread must expose an id");

    const request = "Create a todo app in this selected project using only Node.js built-ins and browser HTML/CSS/JavaScript, with package.json npm start, PORT support, and add/complete/remove controls. Verify it starts and summarize how to run it.";

    chatAbort = new AbortController();
    const responsePromise = fetch(`http://127.0.0.1:${apiPort}/api/threads/${encodeURIComponent(threadId)}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: request }),
      signal: chatAbort.signal,
    });

    let startedSession: { id: string; taskId: string; agentId: string };
    try {
      startedSession = await waitForFreshWorkerSession(chef, workerIds, existingSessionIds, startupBudgetMs);
    } catch (error) {
      chatAbort.abort();
      await responsePromise.catch(() => undefined);
      throw error;
    }

    const response = await responsePromise;
    requestCompleted = true;
    const body = await response.json() as { ok?: boolean; data?: { ok?: boolean; taskIds?: string[]; report?: string }; error?: string };

    assert.ok(
      inFlightProgressEvents.length > 0,
      `Chef produced no Mission/Task/Session progress while the canonical request was in flight. Recent progress trace:\n${formatProgressTrace(progressEvents)}`,
    );
    assert.equal(response.status, 200, `Chef Thread chat request failed: ${JSON.stringify(body)}`);
    assert.equal(body.ok, true, body.error ?? body.data?.report ?? "Chef reported failure");
    assert.equal(body.data?.ok, true, body.data?.report ?? "Mission did not complete successfully");
    assert.ok((body.data?.taskIds?.length ?? 0) > 0, "Mission must create at least one task");
    assert.ok(body.data!.taskIds!.includes(startedSession.taskId), "Observed fresh CLI Session must belong to the completed Mission");

    const snapshot = await chef.inspectState();
    const taskIds = new Set(body.data!.taskIds!);
    const missionTasks = snapshot.tasks.filter((task) => taskIds.has(task.id));
    const missionSessions = snapshot.sessions.filter((session) => taskIds.has(session.taskId));
    const singleWorkerRoutingEvent = snapshot.events.find((event) => {
      if (event.type !== "orchestrator.plan.proposed" || !event.payload || typeof event.payload !== "object") return false;
      return (event.payload as { routingMode?: unknown }).routingMode === "single-worker";
    });

    assert.ok(singleWorkerRoutingEvent, "Canonical todo request must durably record the single-worker route instead of paying a planner round-trip");
    assert.equal(missionTasks.length, taskIds.size, "Every returned task must exist in durable state");
    assert.ok(missionTasks.every((task) => task.status === "completed"), "Every Mission task must complete");
    assert.ok(missionSessions.some((session) => session.id === startedSession.id), "The bounded startup Session must remain in durable Mission state");
    assert.ok(missionSessions.every((session) => session.status === "completed"), "Every Mission worker session must terminate successfully");
    assert.ok(snapshot.events.some((event) => event.type === "task.completed"), "Runtime must record task completion");

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
    console.log(`Thread: ${threadId}`);
    console.log(`Worker startup: session=${startedSession.id} task=${startedSession.taskId} within ${startupBudgetMs}ms budget.`);
    console.log("Routing: single-worker (durable orchestrator.plan.proposed evidence).");
    console.log(`Observed ${inFlightProgressEvents.length} in-flight Mission/Task/Session progress events.`);
    console.log(`Chef summary: ${body.data?.report ?? "(no report)"}`);
  } finally {
    requestCompleted = true;
    chatAbort?.abort();
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
