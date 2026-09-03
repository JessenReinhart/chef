import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GenericTerminalHarness } from "../src/harness/generic.ts";
import { createChef } from "../src/main.ts";
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
import { summarizeMissionProgressForMission } from "../web/src/missionProgress.ts";
import { createMissionProgressRefreshQueue } from "../web/src/missionProgressStream.ts";
import type { UiRuntimeEvent } from "../web/src/types.ts";

const TODO_REQUEST = "Create a simple todo app";

class HeartbeatAcceptanceProvider implements DecisionProvider {
  readonly name = "heartbeat-runtime-acceptance";
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
        assignedTo: "heartbeat-worker",
      }],
      taskIds: [taskId],
      createdAt: Date.now(),
    };
  }

  harnessFor(agentId: AgentId, workspaceId: WorkspaceId): GenericTerminalHarness {
    assert.equal(agentId, "heartbeat-worker");
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
      summary: accepted ? "Todo heartbeat worker completed" : `Todo heartbeat worker ended as ${taskResult.status}`,
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

async function proveSharedRefreshBudget(): Promise<void> {
  let refreshCount = 0;
  let releaseFirstRefresh!: () => void;
  const firstRefresh = new Promise<void>((resolve) => { releaseFirstRefresh = resolve; });
  const queue = createMissionProgressRefreshQueue(() => {
    refreshCount += 1;
    return refreshCount === 1 ? firstRefresh : Promise.resolve();
  });

  queue.trigger();
  await Promise.resolve();
  assert.equal(refreshCount, 1, "the initial Simple Mode activity refresh should start immediately");

  queue.trigger();
  queue.trigger();
  queue.trigger();
  assert.equal(
    refreshCount,
    1,
    "timer and live invalidations must not start concurrent authoritative refreshes while one is in flight",
  );

  releaseFirstRefresh();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    refreshCount,
    2,
    "bursty invalidations must retain exactly one trailing refresh so the newest activity is still observed",
  );

  queue.close();
  queue.trigger();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(refreshCount, 2, "an unmounted activity rail must not schedule more refresh work");
}

async function main(): Promise<void> {
  await proveSharedRefreshBudget();

  const projectDir = await mkdtemp(join(tmpdir(), "chef-heartbeat-runtime-"));
  const dbPath = join(projectDir, "chef.sqlite");
  const workerScript = join(projectDir, "heartbeat-worker.cjs");
  await writeFile(
    workerScript,
    'console.log("heartbeat-worker: started");\nsetTimeout(() => process.exit(0), 800);\n',
    "utf8",
  );

  let chef: ReturnType<typeof createChef> | null = null;
  try {
    chef = createChef({
      dbPath,
      projectDir,
      decisionProvider: new HeartbeatAcceptanceProvider(projectDir, workerScript),
      orchestratorTimeoutMs: 5_000,
    });
    await chef.start();

    const events: RuntimeEvent[] = [];
    const unsubscribe = chef.subscribeEvents((event) => events.push(event));
    let sendSettled = false;
    const sendPromise = chef.sendUserMessage(TODO_REQUEST).finally(() => { sendSettled = true; });

    const missionCreated = await waitForEvent(
      events,
      (event) => event.type === "mission.created",
      500,
      "Mission creation",
    );
    const workerOutput = await waitForEvent(
      events,
      (event) => event.type === "session.data" && event.taskId !== undefined,
      2_000,
      "real worker session output",
    );
    assert.equal(sendSettled, false, "the Mission must still be unresolved while its worker is active");

    const taskId = workerOutput.taskId;
    assert.ok(taskId, "worker output must retain Task lineage");
    const eventPrefix = events.filter((event) => event.seq <= workerOutput.seq);
    const progress = summarizeMissionProgressForMission(
      eventPrefix as UiRuntimeEvent[],
      missionCreated.source.id,
      [taskId],
      3,
      workerOutput.timestamp + 10_000,
    );

    assert.equal(progress[0]?.eventType, "mission.heartbeat", "real unresolved worker activity must project a Simple Mode heartbeat after runtime silence");
    assert.equal(
      progress[0]?.text,
      "Chef is still working. Last runtime activity was 10 seconds ago.",
      "the cross-boundary heartbeat must stay human-readable and truthful",
    );
    assert.equal(sendSettled, false, "heartbeat projection must be available before the canonical request finishes");

    const result = await sendPromise;
    unsubscribe();
    assert.equal(result.ok, true, `canonical todo request failed after heartbeat projection: ${result.report}`);
    assert.equal(result.taskIds.length, 1, "reference todo work should retain one real worker Task");
  } finally {
    if (chef) await chef.close().catch(() => undefined);
    await rm(projectDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
