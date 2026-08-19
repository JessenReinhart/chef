import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createChef } from "../src/main.ts";
import { GenericTerminalHarness } from "../src/harness/generic.ts";
import type { ContextReference } from "../src/core/types.ts";
import type { HarnessLike } from "../src/runtime/scheduler.ts";
import { createHttpServer } from "../src/server/http-server.ts";

const testFile = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(testFile), "..");
const fixture = join(repoRoot, "tests", "fixtures", "specialized-artifact-worker.mjs");

async function eventually<T>(read: () => T, accept: (value: T) => boolean, label: string): Promise<T> {
  // Windows winpty may take several seconds to deliver its first ready/data
  // event; acceptance waits for the real child rather than a mocked queue.
  const deadline = Date.now() + 20_000;
  let last: T | undefined;
  while (Date.now() < deadline) {
    const value = read();
    last = value;
    if (accept(value)) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`timed out waiting for ${label}; last value: ${JSON.stringify(last)}`);
}

function schedulerHarness(harness: GenericTerminalHarness, cwd: string): HarnessLike {
  return {
    id: harness.id,
    command: harness.command,
    args: harness.args,
    cwd,
    spawn: (options) => harness.spawn(options),
    events: (sessionId) => harness.events(sessionId),
    send: (sessionId, input) => harness.send(sessionId, input),
    interrupt: (sessionId) => harness.interrupt(sessionId),
    resize: (sessionId, cols, rows) => harness.resize(sessionId, cols, rows),
    terminate: (sessionId) => harness.terminate(sessionId),
    forget: (sessionId) => harness.forget(sessionId),
    writeContextRefs: (sessionId: string, refs: ContextReference[]) => harness.writeContextRefs(sessionId, refs),
    writeMessage: (sessionId, from, text) => harness.writeMessage(sessionId, from, text),
    close: () => harness.close(),
  };
}

async function closeServer(server: ReturnType<typeof createHttpServer>): Promise<void> {
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
}

async function exercisePaletteDispatch(root: string): Promise<void> {
  const dbPath = join(root, "runtime.sqlite");
  const chef = createChef({ dbPath, projectDir: root });
  await chef.start();
  const terminalHarness = new GenericTerminalHarness({
    agentId: "generic",
    workspaceId: chef.workspaceId,
    command: process.execPath,
    args: [fixture],
    cwd: root,
  });
  chef.registerHarness("generic", schedulerHarness(terminalHarness, root));
  const server = createHttpServer(chef);
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const capabilitiesResponse = await fetch(`${baseUrl}/api/capabilities?role=engineer`);
    assert.equal(capabilitiesResponse.status, 200);
    const capabilities = await capabilitiesResponse.json() as { data: { role: string; policy: Record<string, string> } };
    assert.equal(capabilities.data.role, "engineer");
    assert.equal(capabilities.data.policy.terminal, "allow");
    assert.equal(capabilities.data.policy.browser, "deny");

    const invalidCapabilities = await fetch(`${baseUrl}/api/capabilities?role=owner`);
    assert.equal(invalidCapabilities.status, 400);

    const browserResponse = await fetch(`${baseUrl}/api/nodes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "tool.browser", title: "Browser", kind: "tool", autoDispatch: true }),
    });
    assert.equal(browserResponse.status, 201);
    const browser = await browserResponse.json() as {
      data: { taskId: string; assignedTo?: string; execution: { status: string; reason: string } };
    };
    assert.equal(browser.data.assignedTo, undefined, "browser must not masquerade as a terminal harness");
    assert.equal(browser.data.execution.status, "configuration_required");
    assert.match(browser.data.execution.reason, /browser action and URL/i);
    assert.equal(chef.repository.getTask(browser.data.taskId)?.status, "pending");

    const terminalResponse = await fetch(`${baseUrl}/api/nodes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "tool.terminal", title: "Palette terminal", kind: "tool", autoDispatch: true }),
    });
    assert.equal(terminalResponse.status, 201);
    const terminal = await terminalResponse.json() as {
      data: { taskId: string; assignedTo: string; execution: { status: string } };
    };
    assert.equal(terminal.data.assignedTo, "generic");
    assert.equal(terminal.data.execution.status, "started");

    const liveSession = await eventually(
      () => chef.repository.listSessions(chef.workspaceId).find((session) => session.taskId === terminal.data.taskId),
      (session) => session?.status === "running",
      "palette terminal PTY",
    );
    const completedState = await eventually(
      () => ({
        task: chef.repository.getTask(terminal.data.taskId),
        session: chef.repository.listSessions(chef.workspaceId).find((candidate) => candidate.id === liveSession!.id),
      }),
      (state) => (state.task?.status === "completed" || state.task?.status === "failed") &&
        (state.session?.status === "completed" || state.session?.status === "crashed"),
      "standalone terminal terminal state",
    );
    assert.equal(completedState.task?.status, "completed", completedState.task?.error ?? "task did not complete");
    const persistedSession = chef.repository.listSessions(chef.workspaceId).find((session) => session.id === liveSession!.id);
    assert.equal(persistedSession?.status, "completed");

    const inspectorResponse = await fetch(`${baseUrl}/api/inspector/events?limit=1000`);
    assert.equal(inspectorResponse.status, 200);
    const inspector = await inspectorResponse.json() as { data: Array<{ type: string; sessionId?: string; payload: unknown }> };
    const visibleOutput = inspector.data
      .filter((event) => event.type === "session.data" && event.sessionId === liveSession!.id)
      .map((event) => (event.payload as { data?: string }).data ?? "")
      .join("");
    assert.match(visibleOutput, /SPECIALIZED-ARTIFACT-WRITTEN/);
    assert.ok(chef.repository.listArtifacts(chef.workspaceId).some((artifact) => artifact.taskId === terminal.data.taskId));
  } finally {
    await closeServer(server);
    await chef.close();
  }

  const restarted = createChef({ dbPath, projectDir: root });
  await restarted.start();
  try {
    const restored = await restarted.inspectState();
    const terminal = restored.tasks.find((task) => task.title === "Palette terminal");
    assert.equal(terminal?.status, "completed");
    const session = restored.sessions.find((candidate) => candidate.taskId === terminal?.id);
    assert.equal(session?.status, "completed");
    assert.ok(restored.events.some((event) => event.sessionId === session?.id && event.type === "session.data"));
  } finally {
    await restarted.close();
  }
}

function startProductionServer(root: string, dbPath: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ["--experimental-strip-types", "src/server/index.ts"], {
    cwd: repoRoot,
    env: { ...process.env, CHEF_PORT: "0", CHEF_PROJECT_DIR: root, CHEF_DB_PATH: dbPath },
    stdio: "pipe",
  });
}

async function serverUrl(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolveUrl, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error(`server did not start: ${output}`)), 12_000);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (!match) return;
      clearTimeout(timeout);
      resolveUrl(`http://127.0.0.1:${match[1]}`);
    });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`server exited before readiness (${code}): ${output}`));
    });
  });
}

async function stopProductionServer(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolveExit, reject) => {
    const timeout = setTimeout(() => reject(new Error("production server did not stop after SIGTERM")), 10_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveExit();
    });
  });
}

async function exerciseDurableProductionEntrypoint(root: string): Promise<void> {
  const dbPath = join(root, "durable", "chef.sqlite");
  let child = startProductionServer(root, dbPath);
  try {
    const baseUrl = await serverUrl(child);
    const response = await fetch(`${baseUrl}/api/nodes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "tool.browser", title: "Survives server restart", kind: "tool" }),
    });
    assert.equal(response.status, 201);
  } finally {
    await stopProductionServer(child);
  }
  assert.ok(existsSync(dbPath), "production shutdown must retain its configured database");

  child = startProductionServer(root, dbPath);
  try {
    const baseUrl = await serverUrl(child);
    const stateResponse = await fetch(`${baseUrl}/api/state`);
    assert.equal(stateResponse.status, 200);
    const state = await stateResponse.json() as { tasks: Array<{ title: string }> };
    assert.ok(state.tasks.some((task) => task.title === "Survives server restart"));
  } finally {
    await stopProductionServer(child);
  }
  assert.ok(existsSync(dbPath), "second production shutdown must also retain state");
}

const root = mkdtempSync(join(tmpdir(), "chef-server-runtime-"));
try {
  await exercisePaletteDispatch(root);
  await exerciseDurableProductionEntrypoint(root);
  console.log("server-runtime-surfaces: PASS");
} finally {
  rmSync(root, { recursive: true, force: true });
}
