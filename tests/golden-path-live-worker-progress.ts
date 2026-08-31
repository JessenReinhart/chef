import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenericTerminalHarness } from "../src/harness/generic.ts";
import { createChef } from "../src/main.ts";
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

async function main(): Promise<void> {
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

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});