import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenericTerminalHarness } from "../src/harness/generic.ts";
import { createChef } from "../src/main.ts";
import { createRecoveryServer } from "../src/server/recovery-http.ts";
import { summarizeMissionProgressEvent } from "../web/src/missionProgress.ts";
import type {
  AgentId,
  Decision,
  DecisionProvider,
  Plan,
  PlanProposalContext,
  PlanTaskOutcome,
  RuntimeEvent,
  WorkspaceId,
} from "../src/core/types.ts";

const TODO_REQUEST = "Create a simple todo app";

class SlowTodoDecisionProvider implements DecisionProvider {
  readonly name = "golden-live-worker-progress";
  readonly #projectDir: string;
  readonly #workerScript: string;
  #workspaceId: WorkspaceId = "";

  constructor(projectDir: string, workerScript: string) {
    this.#projectDir = projectDir;
    this.#workerScript = workerScript;
  }

  async proposePlan(input: PlanProposalContext): Promise<Plan & { routingMode: "single-worker" }> {
    this.#workspaceId = input.workspaceId;
    const taskId = crypto.randomUUID();
    return {
      id: crypto.randomUUID(),
      workspaceId: input.workspaceId,
      goal: input.goal,
      status: "proposed",
      routingMode: "single-worker",
      tasks: [{
        id: taskId,
        title: "Build the todo app",
        description: input.goal,
        dependencies: [],
        priority: 1,
        assignedTo: "todo-builder",
      }],
      taskIds: [taskId],
      createdAt: Date.now(),
    };
  }

  harnessFor(agentId: AgentId, workspaceId: WorkspaceId): GenericTerminalHarness {
    return new GenericTerminalHarness({
      agentId,
      workspaceId,
      command: process.execPath,
      args: [this.#workerScript],
      cwd: this.#projectDir,
    });
  }

  async evaluate(taskResult: PlanTaskOutcome): Promise<Decision> {
    const accepted = taskResult.status === "completed";
    return {
      id: crypto.randomUUID(),
      workspaceId: this.#workspaceId,
      type: "task.evaluation",
      summary: accepted ? "Slow todo worker completed" : `Slow todo worker ended as ${taskResult.status}`,
      payload: taskResult,
      madeBy: this.name,
      timestamp: Date.now(),
      status: accepted ? "accepted" : "rejected",
    };
  }
}

async function waitForEvent(
  events: readonly RuntimeEvent[],
  predicate: (event: RuntimeEvent) => boolean,
  timeoutMs: number,
  label: string,
): Promise<RuntimeEvent> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = events.find(predicate);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`${label} was not observable within ${timeoutMs} ms`);
}

async function assertLiveWorkerProgress(): Promise<void> {
  const projectDir = await mkdtemp(join(tmpdir(), "chef-golden-live-progress-"));
  const dbPath = join(projectDir, "chef.sqlite");

  try {
    const workerScript = join(projectDir, "slow-todo-worker.cjs");
    await writeFile(
      workerScript,
      `console.log("todo-builder: working");\nconst deadline = Date.now() + 1200;\nwhile (Date.now() < deadline) {}\nconsole.log("todo-builder: done");\n`,
      "utf8",
    );

    const chef = createChef({
      dbPath,
      projectDir,
      decisionProvider: new SlowTodoDecisionProvider(projectDir, workerScript),
      orchestratorTimeoutMs: 10_000,
    });
    await chef.start();

    const liveEvents: RuntimeEvent[] = [];
    const unsubscribe = chef.subscribeEvents((event) => liveEvents.push(event));
    let sendSettled = false;
    const sendPromise = chef.sendUserMessage(TODO_REQUEST).finally(() => { sendSettled = true; });

    const runningEvent = await waitForEvent(
      liveEvents,
      (event) => event.type === "task.running",
      5_000,
      "meaningful worker progress",
    );
    assert.ok(runningEvent.taskId, "live worker progress must identify the running task");
    assert.equal(sendSettled, false, "worker-running progress must be observable before request completion");

    const projectedProgress = summarizeMissionProgressEvent(runningEvent);
    assert.ok(projectedProgress, "live worker progress must cross the Simple Mode projection boundary");
    assert.equal(projectedProgress.tone, "active", "live worker progress must remain visibly active in Simple Mode");
    assert.equal(
      projectedProgress.text,
      "A worker started a work step.",
      "live worker progress must become human-readable feedback instead of raw runtime jargon",
    );

    const result = await sendPromise;
    unsubscribe();
    assert.equal(result.ok, true, `orchestrator failed: ${result.report}`);
    assert.deepEqual(result.taskIds, [runningEvent.taskId], "live worker progress must belong to the canonical task");

    const snapshot = await chef.inspectState();
    assert.ok(
      snapshot.events.some((event) => event.taskId === runningEvent.taskId && event.type === "task.completed"),
      "worker progress must later resolve to durable completion",
    );

    await chef.close();
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

async function assertFailedWorkerCanRecover(): Promise<void> {
  const projectDir = await mkdtemp(join(tmpdir(), "chef-golden-retry-"));
  const dbPath = join(projectDir, "chef.sqlite");
  const markerPath = join(projectDir, "retry-marker");

  try {
    const workerScript = join(projectDir, "fail-once-todo-worker.cjs");
    await writeFile(
      workerScript,
      `const fs = require("fs");\nconst marker = ${JSON.stringify(markerPath)};\nif (!fs.existsSync(marker)) { fs.writeFileSync(marker, "failed-once"); console.error("todo-builder: recoverable failure"); process.exit(1); }\nconsole.log("todo-builder: recovered");\n`,
      "utf8",
    );

    const chef = createChef({
      dbPath,
      projectDir,
      decisionProvider: new SlowTodoDecisionProvider(projectDir, workerScript),
      orchestratorTimeoutMs: 10_000,
    });
    await chef.start();

    const liveEvents: RuntimeEvent[] = [];
    const unsubscribe = chef.subscribeEvents((event) => liveEvents.push(event));
    const firstResult = await chef.sendUserMessage(TODO_REQUEST);
    assert.equal(firstResult.ok, false, "the fail-once worker must expose the initial failure");
    assert.equal(firstResult.taskIds.length, 1, "recovery scenario must stay on one canonical task");
    const taskId = firstResult.taskIds[0];

    const failedEvent = await waitForEvent(
      liveEvents,
      (event) => event.taskId === taskId && event.type === "task.failed",
      2_000,
      "worker failure",
    );
    const failedProgress = summarizeMissionProgressEvent(failedEvent);
    assert.ok(failedProgress, "worker failure must cross the Simple Mode projection boundary");
    assert.equal(failedProgress.tone, "attention", "worker failure must visibly require attention");
    assert.match(failedProgress.text, /failed/i, "worker failure must be understandable without raw runtime state");

    const failedSeq = failedEvent.seq;
    const fallback = createServer((_req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "not found" }));
    });
    const recoveryServer = createRecoveryServer(chef, fallback);
    await new Promise<void>((resolve) => recoveryServer.listen(0, "127.0.0.1", resolve));
    try {
      const address = recoveryServer.address();
      assert.ok(address && typeof address === "object", "recovery server must expose a local address");
      const retryResponse = await fetch(`http://127.0.0.1:${address.port}/api/nodes/${taskId}/retry`, { method: "POST" });
      assert.equal(retryResponse.status, 200, "Simple Mode retry route must accept the failed canonical task");
      const retryBody = await retryResponse.json() as { ok?: boolean; data?: { id?: string; status?: string } };
      assert.equal(retryBody.ok, true, "Simple Mode retry route must report successful recovery dispatch");
      assert.equal(retryBody.data?.id, taskId, "retry response must identify the same canonical task");
      assert.equal(retryBody.data?.status, "running", "retry response must immediately return the task to active work");
    } finally {
      await new Promise<void>((resolve) => recoveryServer.close(() => resolve()));
    }

    const retryRunning = await waitForEvent(
      liveEvents,
      (event) => event.seq > failedSeq && event.taskId === taskId && event.type === "task.running",
      2_000,
      "retry progress",
    );
    const retryProgress = summarizeMissionProgressEvent(retryRunning);
    assert.ok(retryProgress, "retry must cross the Simple Mode projection boundary");
    assert.equal(retryProgress.tone, "active", "retry must visibly return the task to active work");
    assert.match(retryProgress.text, /retrying/i, "retry must be described as recovery rather than a frozen loading state");

    await waitForEvent(
      liveEvents,
      (event) => event.seq > retryRunning.seq && event.taskId === taskId && event.type === "task.completed",
      5_000,
      "retried task completion",
    );
    const snapshot = await chef.inspectState();
    const recoveredTask = snapshot.tasks.find((task) => task.id === taskId);
    assert.equal(recoveredTask?.status, "completed", "retry worker exit must be consumed and persisted as durable completion");
    assert.ok(
      snapshot.sessions.filter((session) => session.taskId === taskId).some((session) => session.status === "completed"),
      "retry must persist the recovered worker session instead of leaving it running",
    );

    unsubscribe();
    await chef.close();
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

await assertLiveWorkerProgress();
await assertFailedWorkerCanRecover();
console.log("golden-path-live-worker-progress: ok — live work and Simple Mode failure recovery stay observable through durable completion");
