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
import { deriveMissionHeartbeat, summarizeMissionProgressForMission } from "../web/src/missionProgress.ts";
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

function approvalHeartbeatEvents(decision?: "accepted" | "rejected"): UiRuntimeEvent[] {
  const missionId = "mission-approval-heartbeat";
  const taskId = "task-approval-heartbeat";
  const events: UiRuntimeEvent[] = [
    {
      id: "mission-active",
      seq: 1,
      timestamp: 1_000,
      source: { type: "mission", id: missionId },
      type: "mission.status",
      payload: { status: "active" },
      correlationId: missionId,
    },
    {
      id: "approval-requested",
      seq: 2,
      timestamp: 2_000,
      source: { type: "approval", id: "approval-heartbeat" },
      type: "approval.requested",
      payload: { reason: "Allow the worker to continue" },
      taskId,
      correlationId: missionId,
    },
  ];
  if (decision) {
    events.push({
      id: `approval-${decision}`,
      seq: 3,
      timestamp: 3_000,
      source: { type: "approval", id: "approval-heartbeat" },
      type: "approval.resolved",
      payload: { decision },
      taskId,
      correlationId: missionId,
    });
  }
  return events;
}

function proveApprovalHeartbeatRecovery(): void {
  const missionId = "mission-approval-heartbeat";
  const taskId = "task-approval-heartbeat";

  assert.equal(
    deriveMissionHeartbeat(approvalHeartbeatEvents(), missionId, [taskId], 12_000),
    null,
    "an unresolved approval must keep the Mission heartbeat suppressed",
  );

  const accepted = approvalHeartbeatEvents("accepted");
  assert.equal(
    deriveMissionHeartbeat(accepted, missionId, [taskId], 13_000),
    null,
    "an accepted approval is acknowledgement, not evidence that runtime work resumed",
  );

  accepted.push({
    id: "retry-after-acceptance",
    seq: 4,
    timestamp: 4_000,
    source: { type: "task", id: taskId },
    type: "task.running",
    payload: { retryCount: 0 },
    taskId,
    correlationId: missionId,
  });
  assert.equal(
    deriveMissionHeartbeat(accepted, missionId, [taskId], 14_000)?.text,
    "Chef is still working. Last runtime activity was 10 seconds ago.",
    "accepted approval may restore heartbeat only after real task runtime resumes",
  );

  assert.equal(
    deriveMissionHeartbeat(approvalHeartbeatEvents("rejected"), missionId, [taskId], 13_000),
    null,
    "a rejected approval must remain a terminal heartbeat blocker",
  );

  const rejectedThenRetried = approvalHeartbeatEvents("rejected");
  rejectedThenRetried.push({
    id: "retry-after-rejection",
    seq: 4,
    timestamp: 4_000,
    source: { type: "task", id: taskId },
    type: "task.running",
    payload: { retryCount: 1 },
    taskId,
    correlationId: missionId,
  });
  assert.equal(
    deriveMissionHeartbeat(rejectedThenRetried, missionId, [taskId], 14_000)?.text,
    "Chef is still working. Last runtime activity was 10 seconds ago.",
    "a rejected approval must close its request while a later real task retry restores heartbeat feedback",
  );

  const overlappingApprovals = approvalHeartbeatEvents("accepted");
  overlappingApprovals[2] = { ...overlappingApprovals[2]!, seq: 4, timestamp: 4_000 };
  overlappingApprovals.splice(2, 0, {
    id: "other-approval-requested",
    seq: 3,
    timestamp: 3_000,
    source: { type: "approval", id: "other-approval" },
    type: "approval.requested",
    payload: { reason: "A second independent approval is still pending" },
    taskId,
    correlationId: missionId,
  });
  assert.equal(
    deriveMissionHeartbeat(overlappingApprovals, missionId, [taskId], 14_000),
    null,
    "accepting one approval must not clear another approval that is still pending",
  );
}

function proveTaskScopedHeartbeatRecovery(): void {
  const missionId = "mission-parallel-heartbeat";
  const taskA = "task-a";
  const taskB = "task-b";
  const active: UiRuntimeEvent = {
    id: "parallel-active",
    seq: 1,
    timestamp: 1_000,
    source: { type: "mission", id: missionId },
    type: "mission.status",
    payload: { status: "active" },
    correlationId: missionId,
  };

  for (const blockerType of ["task.failed", "task.blocked", "task.cancelled", "session.crashed"] as const) {
    const blocked: UiRuntimeEvent[] = [
      active,
      {
        id: `${blockerType}-a`,
        seq: 2,
        timestamp: 2_000,
        source: { type: "task", id: taskA },
        type: blockerType,
        payload: blockerType === "task.failed" ? { error: "worker exited" } : { reason: "needs recovery" },
        taskId: taskA,
        correlationId: missionId,
      },
      {
        id: "task-b-running",
        seq: 3,
        timestamp: 3_000,
        source: { type: "task", id: taskB },
        type: "task.running",
        payload: {},
        taskId: taskB,
        correlationId: missionId,
      },
    ];

    assert.equal(
      deriveMissionHeartbeat(blocked, missionId, [taskA, taskB], 13_000),
      null,
      `${blockerType} must remain authoritative when only a different parallel task resumes`,
    );

    const recovered: UiRuntimeEvent[] = [
      ...blocked,
      {
        id: "task-a-retry",
        seq: 4,
        timestamp: 4_000,
        source: { type: "task", id: taskA },
        type: "task.running",
        payload: { retryCount: 1 },
        taskId: taskA,
        correlationId: missionId,
      },
      {
        id: "task-b-newer-running",
        seq: 5,
        timestamp: 5_000,
        source: { type: "task", id: taskB },
        type: "task.running",
        payload: {},
        taskId: taskB,
        correlationId: missionId,
      },
    ];

    assert.equal(
      deriveMissionHeartbeat(recovered, missionId, [taskA, taskB], 15_000)?.text,
      "Chef is still working. Last runtime activity was 10 seconds ago.",
      `${blockerType} must clear after the same task really retries even when newer unrelated activity exists`,
    );
  }

  const twoFailures: UiRuntimeEvent[] = [
    active,
    {
      id: "task-a-failed",
      seq: 2,
      timestamp: 2_000,
      source: { type: "task", id: taskA },
      type: "task.failed",
      payload: { error: "task A failed" },
      taskId: taskA,
      correlationId: missionId,
    },
    {
      id: "task-b-failed",
      seq: 3,
      timestamp: 3_000,
      source: { type: "task", id: taskB },
      type: "task.failed",
      payload: { error: "task B failed" },
      taskId: taskB,
      correlationId: missionId,
    },
    {
      id: "task-b-retry",
      seq: 4,
      timestamp: 4_000,
      source: { type: "task", id: taskB },
      type: "task.running",
      payload: { retryCount: 1 },
      taskId: taskB,
      correlationId: missionId,
    },
  ];

  assert.equal(
    deriveMissionHeartbeat(twoFailures, missionId, [taskA, taskB], 14_000),
    null,
    "recovering the newest failed task must not hide an older parallel task that is still unresolved",
  );

  twoFailures.push({
    id: "task-a-retry-after-b",
    seq: 5,
    timestamp: 5_000,
    source: { type: "task", id: taskA },
    type: "task.running",
    payload: { retryCount: 1 },
    taskId: taskA,
    correlationId: missionId,
  });
  assert.equal(
    deriveMissionHeartbeat(twoFailures, missionId, [taskA, taskB], 15_000)?.text,
    "Chef is still working. Last runtime activity was 10 seconds ago.",
    "heartbeat may resume only after every parallel task blocker has a compatible recovery",
  );
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
  proveApprovalHeartbeatRecovery();
  proveTaskScopedHeartbeatRecovery();
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
