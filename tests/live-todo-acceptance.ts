import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createChef, type ChefRuntime } from "../src/main.ts";
import { createHttpServer } from "../src/server/http-server.ts";

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

function hasLLMKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.CHEF_API_KEY);
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
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

async function main(): Promise<void> {
  assert.ok(process.env.CHEF_PROVIDER?.trim(), "Set CHEF_PROVIDER before running the live acceptance diagnostic");
  assert.ok(hasLLMKey(), "Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or CHEF_API_KEY before running the live acceptance diagnostic");

  const timeoutMs = Number(process.env.CHEF_E2E_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0, "CHEF_E2E_TIMEOUT_MS must be a positive number");

  const projectDir = await mkdtemp(join(tmpdir(), "chef-todo-acceptance-"));
  const dbPath = join(projectDir, "chef.sqlite");
  let chef: ChefRuntime | undefined;
  let apiServer: Server | undefined;
  let app: ChildProcess | undefined;
  let passed = false;

  try {
    chef = createChef({ dbPath, projectDir, orchestratorTimeoutMs: timeoutMs });
    await chef.start();

    const workers = chef.specializedHarnesses.detections().filter((worker) => worker.available && worker.taskCapable);
    assert.equal(chef.llmStatus.configured, true, "Chef must report a configured planner");
    assert.ok(workers.length > 0, "At least one real task-capable worker must be detected");

    apiServer = createHttpServer(chef);
    await new Promise<void>((resolve, reject) => {
      apiServer!.once("error", reject);
      apiServer!.listen(0, "127.0.0.1", resolve);
    });
    const apiPort = (apiServer.address() as AddressInfo).port;

    const request = [
      "Create a simple todo app in this selected project.",
      "Keep it intentionally small and reliable.",
      "Use only Node.js built-ins plus browser HTML/CSS/JavaScript so installation is not required.",
      "Create package.json with an npm start script.",
      "The server must listen on process.env.PORT and serve the todo UI from /.",
      "The UI must let a user add a todo, mark it complete, and remove it.",
      "Verify the app can start before you finish, then summarize what changed and how to run it.",
    ].join(" ");

    const response = await fetch(`http://127.0.0.1:${apiPort}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: request }),
    });
    const body = await response.json() as { ok?: boolean; data?: { ok?: boolean; taskIds?: string[]; report?: string }; error?: string };

    assert.equal(response.status, 200, `Chef HTTP request failed: ${JSON.stringify(body)}`);
    assert.equal(body.ok, true, body.error ?? body.data?.report ?? "Chef reported failure");
    assert.equal(body.data?.ok, true, body.data?.report ?? "Mission did not complete successfully");
    assert.ok((body.data?.taskIds?.length ?? 0) > 0, "Mission must create at least one task");

    const snapshot = await chef.inspectState();
    const taskIds = new Set(body.data!.taskIds!);
    const missionTasks = snapshot.tasks.filter((task) => taskIds.has(task.id));
    const missionSessions = snapshot.sessions.filter((session) => taskIds.has(session.taskId));

    assert.equal(missionTasks.length, taskIds.size, "Every returned task must exist in durable state");
    assert.ok(missionTasks.every((task) => task.status === "completed"), "Every Mission task must complete");
    assert.ok(missionSessions.length > 0, "The Mission must create at least one real worker session");
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
      stdio: "pipe",
    });

    const appResponse = await waitForHttp(`http://127.0.0.1:${appPort}/`, app);
    const html = await appResponse.text();
    assert.ok(/todo/i.test(html), "Generated app root must visibly identify itself as a todo app");

    passed = true;
    console.log(`live-todo-acceptance: ok (${chef.llmStatus.provider}/${chef.llmStatus.model}; worker candidates: ${workers.map((worker) => worker.id).join(", ")})`);
    console.log(`Chef summary: ${body.data?.report ?? "(no report)"}`);
  } finally {
    if (app && app.exitCode === null) {
      app.kill(process.platform === "win32" ? undefined : "SIGTERM");
    }
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
