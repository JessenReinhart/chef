/**
 * Regression coverage for Mission timeout policy.
 *
 * Core Orchestrator execution is cancellation-driven by default. A caller can
 * still opt into a timeout, and that timeout must abort execution and tear
 * down PTY sessions cleanly.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createChef } from "../src/main.ts";
import { GenericTerminalHarness } from "../src/harness/generic.ts";
import type { DecisionProvider, Plan, AgentId } from "../src/core/types.ts";

class SlowDecisionProvider implements DecisionProvider {
  readonly name = "slow-agent";
  #script: string;
  #planId: string;
  #taskId: string;

  constructor(script: string, planId = "timeout-plan", taskId = "t1") {
    this.#script = script;
    this.#planId = planId;
    this.#taskId = taskId;
  }

  async proposePlan(input: { workspaceId: string; goal: string }): Promise<Plan | null> {
    return {
      id: this.#planId,
      workspaceId: input.workspaceId,
      goal: input.goal,
      status: "proposed",
      taskIds: [this.#taskId],
      createdAt: Date.now(),
      tasks: [
        {
          id: this.#taskId,
          title: "wait for worker",
          description: "runs a node process long enough to exercise Mission timeout policy",
          dependencies: [],
          assignedTo: "investigator",
          priority: 1,
        },
      ],
    };
  }

  harnessFor(agentId: AgentId, workspaceId: string): GenericTerminalHarness {
    if (agentId !== "investigator") throw new Error(`no harness for ${agentId}`);
    return new GenericTerminalHarness({
      agentId,
      workspaceId,
      command: "node",
      args: [this.#script],
    });
  }

  async evaluate(): Promise<{ status: "accepted"; summary: string }> {
    return { status: "accepted", summary: "evaluated" };
  }
}

class HangingEvaluationProvider extends SlowDecisionProvider {
  override async evaluate(): Promise<{ status: "accepted"; summary: string }> {
    return new Promise<never>(() => {});
  }
}

async function within<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForNoLiveTaskSessions(
  chef: ReturnType<typeof createChef>,
  taskId: string,
  timeoutMs: number,
): Promise<void> {
  await within((async () => {
    while (true) {
      const sessions = chef.repository.getWorkspaceSnapshot(chef.workspaceId).sessions.filter((session) => session.taskId === taskId);
      const live = sessions.find((session) => session.status === "running" || session.status === "spawning");
      if (!live) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  })(), timeoutMs, `task ${taskId} still had a live session after timeout cleanup budget`);
}

// Default policy is a constructor contract, not a wall-clock behavior test.
// Keep this assertion deterministic: a successful real worker can legitimately
// run for an arbitrary duration when no Mission deadline is configured.
const orchestratorSource = readFileSync(
  new URL("../src/orchestrator/orchestrator.ts", import.meta.url),
  "utf8",
);
if (orchestratorSource.includes("DEFAULT_TIMEOUT_MS")) {
  throw new Error("core Orchestrator must not restore an implicit default Mission timeout");
}
if (!orchestratorSource.includes("this.#timeoutMs = options.timeoutMs;")) {
  throw new Error("core Orchestrator must keep Mission timeout opt-in");
}
if (!orchestratorSource.includes("if (timeoutMs === undefined) return work;")) {
  throw new Error("unconfigured Mission timeout must bypass timeout racing entirely");
}
if (!orchestratorSource.includes("class MissionTimeoutError extends Error")) {
  throw new Error("configured Mission timeout must use a dedicated internal cause type");
}

// Explicit policy: configured timeout still cancels the Mission and cleans up
// the real PTY process rather than merely racing and abandoning execution.
{
  const dir = mkdtempSync(join(tmpdir(), "chef-timeout-test-"));
  const dbPath = join(dir, "test.db");
  const script = join(dir, "slow-agent.js");
  writeFileSync(script, "setTimeout(() => process.exit(0), 60_000);\n");

  const provider = new SlowDecisionProvider(script);
  const chef = createChef({
    dbPath,
    projectDir: dir,
    decisionProvider: provider,
    orchestratorTimeoutMs: 500,
  });

  const result = await chef.sendUserMessage("run the timeout plan");
  if (result.ok) throw new Error(`expected plan failure on timeout, got: ${result.report}`);
  if (!result.report.includes("Timed out")) {
    throw new Error(`expected timeout error in report, got: ${result.report}`);
  }

  // The timeout response is deliberately no longer coupled to arbitrary
  // downstream settlement. Cancellation continues asynchronously, but a real
  // PTY still has to converge out of its live state within a bounded budget.
  await waitForNoLiveTaskSessions(chef, "t1", 1_500);

  const snapshot = chef.repository.getWorkspaceSnapshot(chef.workspaceId);
  const sessions = snapshot.sessions.filter((s) => s.taskId === "t1");
  for (const session of sessions) {
    if (session.status === "running" || session.status === "spawning") {
      throw new Error(`session ${session.id} still live after bounded timeout cleanup (${session.status})`);
    }
  }

  const timedOutPlan = snapshot.plans.find((plan) => plan.goal.includes("timeout"));
  if (!timedOutPlan) throw new Error("timed-out plan must be persisted durably");
  if (timedOutPlan.status !== "failed") {
    throw new Error(`timed-out plan must be persisted as failed, got: ${timedOutPlan.status}`);
  }
  const timedOutMission = snapshot.missions.find((mission) => mission.planId === timedOutPlan.id);
  if (!timedOutMission) throw new Error("timed-out Mission must remain durably linked to its Plan");

  const timeoutEvents = snapshot.events.filter((event) => event.type === "mission.timeout");
  if (timeoutEvents.length !== 1) {
    throw new Error(`expected exactly one durable mission.timeout event, got ${timeoutEvents.length}`);
  }
  const timeoutPayload = timeoutEvents[0].payload as {
    missionId?: string;
    planId?: string;
    timeoutMs?: number;
    cause?: string;
  };
  if (timeoutPayload.missionId !== timedOutMission.id) {
    throw new Error(`timeout diagnostic Mission mismatch: ${String(timeoutPayload.missionId)}`);
  }
  if (timeoutPayload.planId !== timedOutPlan.id) {
    throw new Error(`timeout diagnostic Plan mismatch: ${String(timeoutPayload.planId)}`);
  }
  if (timeoutPayload.timeoutMs !== 500 || timeoutPayload.cause !== "mission_timeout") {
    throw new Error(`timeout diagnostic must preserve configured policy and cause: ${JSON.stringify(timeoutPayload)}`);
  }

  // close() must not hang on a live PTY that timeout cancellation should have killed.
  const closeTimer = setTimeout(() => {
    throw new Error("close() hung: a PTY survived the timeout cancellation");
  }, 5000);
  closeTimer.unref();
  await chef.close();
  clearTimeout(closeTimer);
  rmSync(dir, { recursive: true, force: true });
}

// A Mission deadline is a user-facing bound even when downstream provider work
// cannot be cancelled. A worker can finish successfully and then leave an
// evaluator Promise pending forever; Chef must still leave Working/Verifying.
{
  const dir = mkdtempSync(join(tmpdir(), "chef-timeout-evaluation-test-"));
  const dbPath = join(dir, "test.db");
  const script = join(dir, "quick-agent.js");
  writeFileSync(script, "process.exit(0);\n");

  const provider = new HangingEvaluationProvider(script, "stuck-evaluation-plan", "evaluated-task");
  const chef = createChef({
    dbPath,
    projectDir: dir,
    decisionProvider: provider,
    orchestratorTimeoutMs: 1_500,
  });

  const startedAt = Date.now();
  const result = await within(
    chef.sendUserMessage("finish the worker then exercise a stuck evaluation"),
    4_000,
    "Mission deadline elapsed but sendUserMessage never returned control",
  );
  const elapsedMs = Date.now() - startedAt;
  if (result.ok) throw new Error(`expected plan failure on stuck evaluation timeout, got: ${result.report}`);
  if (!result.report.includes("Timed out after 1500ms")) {
    throw new Error(`expected configured Mission timeout in report, got: ${result.report}`);
  }
  if (elapsedMs >= 4_000) {
    throw new Error(`Mission timeout was not a real response bound (${elapsedMs}ms)`);
  }

  const snapshot = chef.repository.getWorkspaceSnapshot(chef.workspaceId);
  const task = snapshot.tasks.find((candidate) => candidate.id === "evaluated-task");
  if (!task || task.status !== "completed") {
    throw new Error(`worker must finish before the evaluator stall is classified as a Mission timeout: ${task?.status ?? "missing"}`);
  }
  const timedOutPlan = snapshot.plans.find((plan) => plan.id === "stuck-evaluation-plan");
  if (!timedOutPlan || timedOutPlan.status !== "failed") {
    throw new Error(`stuck-evaluation Plan must be failed durably, got: ${timedOutPlan?.status ?? "missing"}`);
  }
  const timedOutMission = snapshot.missions.find((mission) => mission.planId === timedOutPlan.id);
  if (!timedOutMission || timedOutMission.status !== "failed") {
    throw new Error(`stuck-evaluation Mission must be failed durably, got: ${timedOutMission?.status ?? "missing"}`);
  }
  const timeoutEvents = snapshot.events.filter((event) => event.type === "mission.timeout");
  if (timeoutEvents.length !== 1) {
    throw new Error(`stuck evaluation must produce exactly one durable mission.timeout event, got ${timeoutEvents.length}`);
  }
  const timeoutPayload = timeoutEvents[0].payload as { missionId?: string; planId?: string; timeoutMs?: number; cause?: string };
  if (
    timeoutPayload.missionId !== timedOutMission.id ||
    timeoutPayload.planId !== timedOutPlan.id ||
    timeoutPayload.timeoutMs !== 1_500 ||
    timeoutPayload.cause !== "mission_timeout"
  ) {
    throw new Error(`stuck-evaluation timeout diagnostic is incomplete: ${JSON.stringify(timeoutPayload)}`);
  }

  await chef.close();
  rmSync(dir, { recursive: true, force: true });
}

// A spontaneous worker failure must stay on the crash/failure path and must
// never be relabeled as a Mission timeout merely because timeout policy exists.
{
  const dir = mkdtempSync(join(tmpdir(), "chef-crash-test-"));
  const dbPath = join(dir, "test.db");
  const script = join(dir, "crash-agent.js");
  writeFileSync(script, "process.exit(7);\n");

  const provider = new SlowDecisionProvider(script, "crash-plan", "crash-task");
  const chef = createChef({
    dbPath,
    projectDir: dir,
    decisionProvider: provider,
    orchestratorTimeoutMs: 5_000,
  });

  const result = await chef.sendUserMessage("run the crash plan");
  if (result.ok) throw new Error(`expected plan failure on worker crash, got: ${result.report}`);

  const snapshot = chef.repository.getWorkspaceSnapshot(chef.workspaceId);
  const timeoutEvents = snapshot.events.filter((event) => event.type === "mission.timeout");
  if (timeoutEvents.length !== 0) {
    throw new Error("spontaneous worker crash must not emit mission.timeout");
  }
  const crashEvents = snapshot.events.filter((event) => event.type === "session.crash" || event.type === "task.failed");
  if (crashEvents.length === 0) {
    throw new Error("spontaneous worker failure must remain observable on the existing crash/failure path");
  }

  await chef.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log("timeout-cancellation: ok — Mission deadlines are bounded, timeout diagnostics are explicit, and worker crashes stay distinct");
