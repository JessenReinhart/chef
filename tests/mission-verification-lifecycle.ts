import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentId,
  ContextReference,
  Decision,
  HarnessEvent,
  Plan,
  PlanProposalContext,
  PlanTaskOutcome,
  WorkspaceId,
} from "../src/core/types.ts";
import { createChef, type ChefRuntime } from "../src/main.ts";
import type { HarnessLike } from "../src/runtime/scheduler.ts";

type SessionState = { released: boolean; terminated: boolean; wake?: () => void };

/** Deterministic worker so the test can stop a Mission before completion. */
class VerificationHarness implements HarnessLike {
  readonly id = "verification-lifecycle-agent";
  readonly command = "verification-lifecycle";
  readonly args: string[] = [];
  readonly cwd: string;
  readonly sessions = new Map<string, SessionState>();
  autoExit = true;

  constructor(cwd: string) { this.cwd = cwd; }

  async spawn(options: { sessionId?: string }): Promise<{ id: string; pid: number }> {
    const id = options.sessionId ?? randomUUID();
    this.sessions.set(id, { released: this.autoExit, terminated: false });
    return { id, pid: this.sessions.size };
  }

  async *events(sessionId: string): AsyncIterable<HarnessEvent> {
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error(`unknown verification session: ${sessionId}`);
    if (!state.released) await new Promise<void>((resolve) => { state.wake = resolve; });
    yield { type: "exit", exitCode: state.terminated ? 143 : 0 };
  }

  async send(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async resize(): Promise<void> {}
  async writeContextRefs(_sessionId: string, _refs: ContextReference[]): Promise<string> { return ""; }
  async writeMessage(): Promise<string> { return ""; }

  async terminate(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.terminated = true;
    state.released = true;
    state.wake?.();
  }

  async forget(): Promise<void> {}
  async close(): Promise<void> {
    for (const sessionId of this.sessions.keys()) await this.terminate(sessionId);
  }
}

class VerificationProvider {
  readonly name = "verification-lifecycle-provider";
  readonly harness: VerificationHarness;

  constructor(harness: VerificationHarness) { this.harness = harness; }

  async proposePlan(input: PlanProposalContext): Promise<Plan> {
    const taskId = randomUUID();
    return {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      goal: input.goal,
      status: "proposed",
      tasks: [{
        id: taskId,
        title: "Build the todo app",
        description: input.goal,
        dependencies: [],
        priority: 1,
        assignedTo: this.harness.id,
      }],
      taskIds: [taskId],
      createdAt: Date.now(),
    };
  }

  harnessFor(_agentId: AgentId, _workspaceId: WorkspaceId): VerificationHarness {
    return this.harness;
  }

  async evaluate(outcome: PlanTaskOutcome): Promise<Decision> {
    return {
      id: randomUUID(),
      workspaceId: "test",
      type: "task.evaluation",
      summary: outcome.status,
      payload: outcome,
      madeBy: this.name,
      timestamp: Date.now(),
      status: outcome.status === "completed" ? "accepted" : "rejected",
    };
  }
}

async function eventually<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 3_000;
  let value = await read();
  while (!accept(value) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    value = await read();
  }
  assert.ok(accept(value), `timed out waiting for ${label}`);
  return value;
}

function statusSequence(chef: ChefRuntime, missionId: string, afterEvent = 0): string[] {
  return chef.repository.getWorkspaceSnapshot(chef.workspaceId).events
    .slice(afterEvent)
    .filter((event) => event.type === "mission.status")
    .map((event) => event.payload as { missionId?: string; status?: string })
    .filter((payload) => payload.missionId === missionId && payload.status !== undefined)
    .map((payload) => payload.status!);
}

const dir = await mkdtemp(join(tmpdir(), "chef-mission-verification-lifecycle-"));
const harness = new VerificationHarness(dir);
const chef = createChef({
  dbPath: join(dir, "chef.sqlite"),
  projectDir: dir,
  decisionProvider: new VerificationProvider(harness),
});

try {
  await chef.start();

  // Permanent reference task: successful worker completion must become a real,
  // durable verification phase before the terminal Mission state.
  const normalResult = await chef.sendUserMessage("Create a simple todo app");
  assert.equal(normalResult.ok, true);
  const normalMission = chef.repository.listMissions(chef.workspaceId).find((mission) => mission.goal === "Create a simple todo app");
  assert.ok(normalMission);
  assert.deepEqual(
    statusSequence(chef, normalMission!.id),
    ["active", "verifying", "completed"],
    "normal Mission completion must durably expose verification before Done",
  );

  // Resume must keep the same lifecycle contract for the fresh attempt rather
  // than jumping directly from active to completed.
  harness.autoExit = false;
  const pausedExecution = chef.sendUserMessage("Create a simple todo app after resume");
  const pausedMission = await eventually(
    () => chef.repository.listMissions(chef.workspaceId).find((mission) => mission.goal === "Create a simple todo app after resume"),
    (mission) => mission?.status === "active",
    "active Mission before pause",
  );
  await eventually(
    () => chef.repository.listSessions(chef.workspaceId).find((session) => pausedMission!.taskIds.includes(session.taskId) && session.status === "running"),
    (session) => session !== undefined,
    "live worker before pause",
  );
  await chef.pauseMission(pausedMission!.id);
  await pausedExecution;
  harness.autoExit = true;
  const resumeEventOffset = chef.repository.getWorkspaceSnapshot(chef.workspaceId).events.length;
  chef.resumeMission(pausedMission!.id);
  await eventually(() => chef.repository.getMission(pausedMission!.id), (mission) => mission?.status === "completed", "resumed Mission completion");
  assert.deepEqual(
    statusSequence(chef, pausedMission!.id, resumeEventOffset),
    ["planning", "active", "verifying", "completed"],
    "resumed attempt must preserve planning -> working -> verifying -> done",
  );

  // Redirect supersedes the live attempt. The replacement attempt owns its
  // verification transition and the stale original cannot overwrite it.
  harness.autoExit = false;
  const redirectedExecution = chef.sendUserMessage("Create a simple todo app before redirect");
  const redirectable = await eventually(
    () => chef.repository.listMissions(chef.workspaceId).find((mission) => mission.goal === "Create a simple todo app before redirect"),
    (mission) => mission?.status === "active",
    "active Mission before redirect",
  );
  await eventually(
    () => chef.repository.listSessions(chef.workspaceId).find((session) => redirectable!.taskIds.includes(session.taskId) && session.status === "running"),
    (session) => session !== undefined,
    "live worker before redirect",
  );
  const oldTaskIds = [...redirectable!.taskIds];
  const redirectEventOffset = chef.repository.getWorkspaceSnapshot(chef.workspaceId).events.length;
  harness.autoExit = true;
  await chef.redirectMission(redirectable!.id, "Create a simple todo app redirected");
  await redirectedExecution;
  const redirected = await eventually(() => chef.repository.getMission(redirectable!.id), (mission) => mission?.status === "completed", "redirected Mission completion");
  assert.notDeepEqual(redirected!.taskIds, oldTaskIds);
  assert.deepEqual(
    statusSequence(chef, redirectable!.id, redirectEventOffset),
    ["active", "verifying", "completed"],
    "replacement attempt must own verification through completion",
  );

  console.log("mission-verification-lifecycle: ok — verification is durable across normal, resume, and redirect paths");
} finally {
  try { await chef.close(); } catch { /* already closed */ }
  await rm(dir, { recursive: true, force: true });
}