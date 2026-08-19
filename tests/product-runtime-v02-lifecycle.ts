import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentId, ContextReference, Decision, HarnessEvent, Plan, PlanProposalContext, PlanTaskOutcome, WorkspaceId } from "../src/core/types.ts";
import { createChef } from "../src/main.ts";
import type { HarnessLike } from "../src/runtime/scheduler.ts";

type SessionState = { released: boolean; terminated: boolean; wake?: () => void };

/** Deterministic harness whose sessions remain live until a test releases them. */
class ControlledHarness implements HarnessLike {
  readonly id: string;
  readonly command = "controlled";
  readonly args: string[] = [];
  readonly cwd: string;
  readonly sessions = new Map<string, SessionState>();
  readonly spawned: string[] = [];
  readonly sent: Array<{ sessionId: string; input: string }> = [];
  readonly terminated: string[] = [];
  autoExit = false;

  constructor(id: string, cwd: string) { this.id = id; this.cwd = cwd; }

  async spawn(options: { sessionId?: string }): Promise<{ id: string; pid: number }> {
    const id = options.sessionId ?? randomUUID();
    this.sessions.set(id, { released: this.autoExit, terminated: false });
    this.spawned.push(id);
    return { id, pid: this.spawned.length };
  }
  async *events(sessionId: string): AsyncIterable<HarnessEvent> {
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error(`unknown controlled session: ${sessionId}`);
    if (!state.released) await new Promise<void>((resolve) => { state.wake = resolve; });
    yield { type: "exit", exitCode: state.terminated ? 143 : 0 };
  }
  release(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error(`unknown controlled session: ${sessionId}`);
    state.released = true;
    state.wake?.();
  }
  async send(sessionId: string, input: string): Promise<void> { this.sent.push({ sessionId, input }); }
  async interrupt(): Promise<void> {}
  async resize(): Promise<void> {}
  async terminate(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (state) { state.terminated = true; state.released = true; state.wake?.(); }
    this.terminated.push(sessionId);
  }
  async forget(): Promise<void> {}
  async writeContextRefs(_sessionId: string, _refs: ContextReference[]): Promise<string> { return ""; }
  async writeMessage(): Promise<string> { return ""; }
  async close(): Promise<void> {
    for (const sessionId of this.sessions.keys()) await this.terminate(sessionId);
  }
}

class MissionProvider {
  readonly name = "v02-lifecycle-provider";
  readonly harnesses: Map<string, ControlledHarness>;
  constructor(harnesses: Map<string, ControlledHarness>) { this.harnesses = harnesses; }
  async proposePlan(input: PlanProposalContext): Promise<Plan> {
    if (input.goal.includes("slow redirected")) {
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
    }
    const agent = input.goal.includes("redirected") ? "redirected-agent" : input.goal.includes("cancel") ? "cancel-agent" : "pause-agent";
    const taskId = randomUUID();
    const taskIds = input.goal.includes("wide mission") ? [taskId, randomUUID()] : [taskId];
    const approvalId = input.goal.includes("approval-scoped") ? randomUUID() : undefined;
    return {
      id: randomUUID(), workspaceId: input.workspaceId, goal: input.goal, status: "proposed",
      tasks: taskIds.map((id, index) => ({
        id, title: `${input.goal} ${index + 1}`, description: input.goal, dependencies: [], priority: 1, assignedTo: agent,
        approvalId: index === 0 ? approvalId : undefined,
      })),
      taskIds, createdAt: Date.now(),
    };
  }
  harnessFor(agentId: AgentId, _workspaceId: WorkspaceId): ControlledHarness {
    const harness = this.harnesses.get(agentId);
    if (!harness) throw new Error(`missing test harness: ${agentId}`);
    return harness;
  }
  async evaluate(outcome: PlanTaskOutcome): Promise<Decision> {
    return { id: randomUUID(), workspaceId: "test", type: "task.evaluation", summary: outcome.status, payload: outcome, madeBy: this.name, timestamp: Date.now(), status: "accepted" };
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

const dir = await mkdtemp(join(tmpdir(), "chef-v02-lifecycle-"));
const pauseHarness = new ControlledHarness("pause-agent", dir);
const cancelHarness = new ControlledHarness("cancel-agent", dir);
const redirectedHarness = new ControlledHarness("redirected-agent", dir);
redirectedHarness.autoExit = true;
const chef = createChef({
  dbPath: join(dir, "chef.sqlite"), projectDir: dir,
  decisionProvider: new MissionProvider(new Map([[pauseHarness.id, pauseHarness], [cancelHarness.id, cancelHarness], [redirectedHarness.id, redirectedHarness]])),
});

try {
  await chef.start();
  const workspaceId = chef.workspaceId;

  // Dependency execution and durable completion are owned by AutomationRunner.
  const automationHarness = new ControlledHarness("automation-agent", dir);
  chef.registerHarness(automationHarness.id, automationHarness);
  for (const [taskId, nodeId] of [["automation-source-a", "automation-node-a"], ["automation-source-b", "automation-node-b"]] as const) {
    chef.repository.insertTask({ id: taskId, workspaceId, title: nodeId, description: nodeId, status: "completed", assignedTo: automationHarness.id });
    chef.repository.upsertCanvasNode({ id: nodeId, workspaceId, taskId, label: nodeId, kind: "agent" });
  }
  const automation = chef.repository.insertAutomation({
    id: "ordered-automation", workspaceId, name: "Ordered automation", nodeIds: ["automation-node-a", "automation-node-b"],
    edges: [{ source: "automation-node-a", target: "automation-node-b", type: "dependency" }],
  });
  const unrelated = chef.repository.insertTask({
    id: "unrelated-pending", workspaceId, title: "Unrelated", description: "must not be swept into an Automation run",
    status: "pending", assignedTo: automationHarness.id,
  });
  const run = chef.runAutomation(automation.id);
  const firstSession = await eventually(
    () => chef.repository.listSessions(workspaceId).find((session) => run.taskIds.includes(session.taskId) && session.status === "running"),
    (session) => session !== undefined, "first Automation session",
  );
  assert.equal(chef.repository.getTask(run.taskIds[1])?.status, "pending", "a dependent step must not start early");
  assert.equal(chef.repository.listSessions(workspaceId).some((session) => session.taskId === run.taskIds[1]), false);
  automationHarness.release(firstSession!.id);
  const secondSession = await eventually(
    () => chef.repository.listSessions(workspaceId).find((session) => session.taskId === run.taskIds[1] && session.status === "running"),
    (session) => session !== undefined, "dependent Automation session",
  );
  automationHarness.release(secondSession!.id);
  await eventually(() => chef.repository.getAutomationRun(run.id), (candidate) => candidate?.status === "completed", "Automation completion");
  assert.ok(run.taskIds.every((taskId) => chef.repository.getTask(taskId)?.status === "completed"));
  assert.equal(chef.repository.getAutomation(automation.id)?.status, "idle");
  assert.equal(chef.repository.getAutomation(automation.id)?.currentRunId, undefined);
  assert.equal(chef.repository.getTask(unrelated.id)?.status, "pending", "Automation dispatch must be isolated to its run task ids");
  assert.equal(chef.repository.listSessions(workspaceId).some((session) => session.taskId === unrelated.id), false);
  await chef.cancelTask(unrelated.id);

  // Stop tears down the owned live session before finalizing the run.
  const stopSource = chef.repository.insertTask({ id: "stop-source", workspaceId, title: "stop source", description: "stop source", status: "completed", assignedTo: automationHarness.id });
  chef.repository.upsertCanvasNode({ id: "stop-node", workspaceId, taskId: stopSource.id, label: "Stop node", kind: "agent" });
  const stoppable = chef.repository.insertAutomation({ id: "stoppable", workspaceId, name: "Stoppable", nodeIds: ["stop-node"] });
  const stopRun = chef.runAutomation(stoppable.id);
  const liveStopSession = await eventually(
    () => chef.repository.listSessions(workspaceId).find((session) => session.taskId === stopRun.taskIds[0] && session.status === "running"),
    (session) => session !== undefined, "stoppable Automation session",
  );
  const stopped = await chef.stopAutomation(stoppable.id);
  assert.equal(stopped.status, "cancelled");
  assert.equal(chef.repository.getTask(stopRun.taskIds[0])?.status, "cancelled");
  assert.ok(automationHarness.terminated.includes(liveStopSession!.id), "Stop must terminate the live harness session");
  assert.equal(chef.repository.listSessions(workspaceId).find((session) => session.id === liveStopSession!.id)?.status, "terminated");

  // A stalled run is judged only by its own sessions. An unrelated live
  // surface must not keep an unassigned Automation alive forever.
  const unrelatedLiveHarness = new ControlledHarness("unrelated-live-agent", dir);
  chef.registerHarness(unrelatedLiveHarness.id, unrelatedLiveHarness);
  const unrelatedLiveTask = chef.repository.insertTask({
    id: "unrelated-live-task", workspaceId, title: "Unrelated live surface", description: "long lived",
    status: "pending", assignedTo: unrelatedLiveHarness.id,
  });
  await chef.dispatchPending();
  const unrelatedLiveSession = await eventually(
    () => chef.repository.listSessions(workspaceId).find((session) => session.taskId === unrelatedLiveTask.id && session.status === "running"),
    (session) => session !== undefined, "unrelated live surface",
  );
  chef.repository.upsertCanvasNode({ id: "unassigned-automation-node", workspaceId, label: "Unassigned step", kind: "tool" });
  const stalledAutomation = chef.repository.insertAutomation({
    id: "stalled-with-unrelated-live", workspaceId, name: "Stalled", nodeIds: ["unassigned-automation-node"],
  });
  const stalledRun = chef.runAutomation(stalledAutomation.id);
  await eventually(
    () => chef.repository.getAutomationRun(stalledRun.id),
    (candidate) => candidate?.status === "failed", "run-scoped Automation stall detection",
  );
  assert.match(chef.repository.getAutomationRun(stalledRun.id)?.error ?? "", /cannot make progress/);

  const capacityAutomation = chef.repository.insertAutomation({
    id: "capacity-queued-automation", workspaceId, name: "Capacity queued", nodeIds: ["automation-node-a"],
  });
  const capacityRun = chef.runAutomation(capacityAutomation.id);
  await eventually(
    () => chef.repository.getAutomationRun(capacityRun.id),
    (candidate) => candidate?.status === "queued", "Automation capacity queue",
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 650));
  assert.equal(chef.repository.getAutomationRun(capacityRun.id)?.status, "queued", "capacity starvation is not intrinsic run failure");
  unrelatedLiveHarness.release(unrelatedLiveSession!.id);
  await eventually(() => chef.repository.getTask(unrelatedLiveTask.id), (task) => task?.status === "completed", "unrelated live surface completion");
  const capacitySession = await eventually(
    () => chef.repository.listSessions(workspaceId).find((session) => session.taskId === capacityRun.taskIds[0] && session.status === "running"),
    (session) => session !== undefined, "capacity-queued Automation dispatch",
  );
  automationHarness.release(capacitySession!.id);
  await eventually(() => chef.repository.getAutomationRun(capacityRun.id), (candidate) => candidate?.status === "completed", "capacity-queued Automation completion");

  // Approval edges create a real durable gate after the source completes.
  const approvalAutomation = chef.repository.insertAutomation({
    id: "approval-automation", workspaceId, name: "Approval automation",
    nodeIds: ["automation-node-a", "automation-node-b"],
    edges: [{ source: "automation-node-a", target: "automation-node-b", type: "approval" }],
  });
  const acceptedRun = chef.runAutomation(approvalAutomation.id);
  const acceptedSourceSession = await eventually(
    () => chef.repository.listSessions(workspaceId).find((session) => session.taskId === acceptedRun.taskIds[0] && session.status === "running"),
    (session) => session !== undefined, "approval Automation source",
  );
  assert.equal(chef.repository.getTask(acceptedRun.taskIds[1])?.status, "pending", "approval is not requested before its source completes");
  automationHarness.release(acceptedSourceSession!.id);
  const acceptedGate = await eventually(
    () => chef.repository.getWorkspaceSnapshot(workspaceId).approvals.find((approval) => approval.taskId === acceptedRun.taskIds[1]),
    (approval) => approval?.status === "pending" && chef.repository.getTask(acceptedRun.taskIds[1])?.status === "blocked",
    "Automation approval wait",
  );
  await eventually(() => chef.repository.getAutomationRun(acceptedRun.id), (candidate) => candidate?.status === "waiting", "Automation waiting status");
  assert.equal(
    chef.repository.getWorkspaceSnapshot(workspaceId).events.filter((event) => event.type === "approval.requested" && event.taskId === acceptedRun.taskIds[1]).length,
    1,
    "Automation polling must announce a durable approval gate exactly once",
  );
  await chef.resolveApproval(acceptedGate!.id, "accepted", "human");
  const acceptedTargetSession = await eventually(
    () => chef.repository.listSessions(workspaceId).find((session) => session.taskId === acceptedRun.taskIds[1] && session.status === "running"),
    (session) => session !== undefined, "accepted Automation target",
  );
  automationHarness.release(acceptedTargetSession!.id);
  await eventually(() => chef.repository.getAutomationRun(acceptedRun.id), (candidate) => candidate?.status === "completed", "accepted Automation completion");

  const rejectedRun = chef.runAutomation(approvalAutomation.id);
  const rejectedSourceSession = await eventually(
    () => chef.repository.listSessions(workspaceId).find((session) => session.taskId === rejectedRun.taskIds[0] && session.status === "running"),
    (session) => session !== undefined, "rejected Automation source",
  );
  automationHarness.release(rejectedSourceSession!.id);
  const rejectedGate = await eventually(
    () => chef.repository.getWorkspaceSnapshot(workspaceId).approvals.find((approval) => approval.taskId === rejectedRun.taskIds[1]),
    (approval) => approval?.status === "pending" && chef.repository.getTask(rejectedRun.taskIds[1])?.status === "blocked",
    "rejected Automation gate",
  );
  await chef.resolveApproval(rejectedGate!.id, "rejected", "human");
  await eventually(() => chef.repository.getAutomationRun(rejectedRun.id), (candidate) => candidate?.status === "failed", "rejected Automation failure");
  assert.equal(chef.repository.getTask(rejectedRun.taskIds[1])?.status, "cancelled");

  const cancelledApprovalRun = chef.runAutomation(approvalAutomation.id);
  const cancelledSourceSession = await eventually(
    () => chef.repository.listSessions(workspaceId).find((session) => session.taskId === cancelledApprovalRun.taskIds[0] && session.status === "running"),
    (session) => session !== undefined, "cancelled Automation source",
  );
  automationHarness.release(cancelledSourceSession!.id);
  await eventually(
    () => chef.repository.getAutomationRun(cancelledApprovalRun.id),
    (candidate) => candidate?.status === "waiting", "cancellable Automation approval wait",
  );
  const cancelledApproval = chef.repository.getWorkspaceSnapshot(workspaceId).approvals.find((approval) => approval.taskId === cancelledApprovalRun.taskIds[1]);
  assert.equal(cancelledApproval?.status, "pending");
  const cancelledRun = await chef.stopAutomation(approvalAutomation.id);
  assert.equal(cancelledRun.status, "cancelled");
  assert.equal(chef.repository.getTask(cancelledApprovalRun.taskIds[1])?.status, "cancelled");

  // An interactive surface can be used without manufacturing a Mission.
  const surfaceHarness = new ControlledHarness("surface-agent", dir);
  chef.registerHarness(surfaceHarness.id, surfaceHarness);
  const surfaceTask = chef.repository.insertTask({ id: "surface-task", workspaceId, title: "Interactive terminal", description: "standalone", status: "pending", assignedTo: surfaceHarness.id });
  chef.repository.upsertCanvasNode({ id: "surface-node", workspaceId, taskId: surfaceTask.id, label: "Interactive terminal", kind: "tool", liveStatus: "offline" });
  const missionCount = chef.repository.listMissions(workspaceId).length;
  chef.activateNode("surface-node");
  await chef.dispatchPending();
  const surfaceSession = await eventually(
    () => chef.repository.listSessions(workspaceId).find((session) => session.taskId === surfaceTask.id && session.status === "running"),
    (session) => session !== undefined, "standalone surface session",
  );
  await chef.interveneNode("surface-node", "inspect independently");
  assert.deepEqual(surfaceHarness.sent.at(-1), { sessionId: surfaceSession!.id, input: "inspect independently\n" });
  assert.equal(chef.repository.listMissions(workspaceId).length, missionCount);
  surfaceHarness.release(surfaceSession!.id);
  await eventually(() => chef.repository.getTask(surfaceTask.id), (task) => task?.status === "completed", "standalone surface completion");

  // Mission dispatch is scoped: neither initial dispatch nor approval resume
  // may sweep an unrelated runnable node into the Mission, and an unrelated
  // live surface remains owned by its standalone lifecycle.
  pauseHarness.autoExit = true;
  const missionLiveHarness = new ControlledHarness("mission-live-agent", dir);
  chef.registerHarness(missionLiveHarness.id, missionLiveHarness);
  const missionLiveTask = chef.repository.insertTask({
    id: "unrelated-mission-live-task", workspaceId, title: "Unrelated Mission live node", description: "stay live",
    status: "pending", assignedTo: missionLiveHarness.id,
  });
  chef.repository.upsertCanvasNode({
    id: "unrelated-mission-live", workspaceId, taskId: missionLiveTask.id, label: "Unrelated Mission live node", kind: "tool", liveStatus: "working",
  });
  await chef.dispatchPending();
  const missionLiveSession = await eventually(
    () => chef.repository.listSessions(workspaceId).find((session) => session.taskId === missionLiveTask.id && session.status === "running"),
    (session) => session !== undefined, "live standalone node before Mission",
  );
  const unrelatedMissionTask = chef.repository.insertTask({
    id: "unrelated-mission-runnable", workspaceId, title: "Unrelated runnable", description: "stay pending",
    status: "pending", assignedTo: surfaceHarness.id,
  });
  const scopedMissionExecution = chef.sendUserMessage("ordinary scoped mission");
  const capacityQueuedMission = await eventually(
    () => chef.repository.listMissions(workspaceId).find((mission) => mission.goal === "ordinary scoped mission"),
    (mission) => mission?.status === "active" && mission.taskIds.every((id) => chef.repository.getTask(id)?.status === "pending"),
    "capacity-queued Mission",
  );
  assert.equal(
    chef.repository.listSessions(workspaceId).some((session) => capacityQueuedMission!.taskIds.includes(session.taskId)),
    false,
    "capacity starvation must queue Mission tasks without stealing the live surface",
  );
  missionLiveHarness.release(missionLiveSession!.id);
  await eventually(() => chef.repository.getTask(missionLiveTask.id), (task) => task?.status === "completed", "unrelated live surface release");
  const scopedMission = await scopedMissionExecution;
  assert.equal(scopedMission.ok, true);
  assert.equal(chef.repository.getTask(unrelatedMissionTask.id)?.status, "pending");
  assert.equal(chef.repository.listSessions(workspaceId).some((session) => session.taskId === unrelatedMissionTask.id), false);
  assert.equal(
    chef.repository.listCanvasNodes(workspaceId).find((node) => node.id === "unrelated-mission-live")?.liveStatus,
    "working",
    "Mission must not take ownership of a live standalone node",
  );
  const approvalMissionExecution = chef.sendUserMessage("approval-scoped mission");
  const approvalMission = await eventually(
    () => chef.repository.listMissions(workspaceId).find((mission) => mission.goal === "approval-scoped mission"),
    (mission) => mission?.status === "active", "approval-scoped Mission",
  );
  const missionGate = await eventually(
    () => chef.repository.getWorkspaceSnapshot(workspaceId).approvals.find((approval) => approvalMission!.taskIds.includes(approval.taskId)),
    (approval) => approval?.status === "pending" && chef.repository.getTask(approval.taskId)?.status === "blocked",
    "Mission approval gate",
  );
  await chef.resolveApproval(missionGate!.id, "accepted", "human");
  const approvalMissionResult = await approvalMissionExecution;
  assert.equal(approvalMissionResult.ok, true);
  assert.equal(chef.repository.getTask(unrelatedMissionTask.id)?.status, "pending", "approval resume must remain Mission-scoped");
  assert.equal(chef.repository.listSessions(workspaceId).some((session) => session.taskId === unrelatedMissionTask.id), false);
  await chef.cancelTask(unrelatedMissionTask.id);

  const wideMission = await chef.sendUserMessage("wide mission batch");
  assert.equal(wideMission.ok, true, "Mission batches wider than scheduler concurrency must drain in waves");
  assert.equal(wideMission.taskIds.length, 2);
  assert.ok(wideMission.taskIds.every((id) => chef.repository.getTask(id)?.status === "completed"));

  // Pause aborts current work; original completion cannot overwrite user control.
  pauseHarness.autoExit = false;
  const pausedExecution = chef.sendUserMessage("pause this mission");
  const pausedMission = await eventually(
    () => chef.repository.listMissions(workspaceId).find((mission) => mission.goal === "pause this mission"),
    (mission) => mission?.status === "active", "active pausable Mission",
  );
  await eventually(
    () => chef.repository.listSessions(workspaceId).find((session) => pausedMission!.taskIds.includes(session.taskId) && session.status === "running"),
    (session) => session !== undefined, "pausable Mission session",
  );
  await chef.pauseMission(pausedMission!.id);
  await pausedExecution;
  assert.equal(chef.repository.getMission(pausedMission!.id)?.status, "paused", "aborted execution must not overwrite paused state");
  assert.ok(pausedMission!.taskIds.every((taskId) => chef.repository.getTask(taskId)?.status === "cancelled"));

  // Resume replans the same Mission and completes a fresh attempt.
  pauseHarness.autoExit = true;
  const missionsBeforeResume = chef.repository.listMissions(workspaceId).length;
  chef.resumeMission(pausedMission!.id);
  const resumed = await eventually(() => chef.repository.getMission(pausedMission!.id), (mission) => mission?.status === "completed", "resumed Mission completion");
  assert.equal(chef.repository.listMissions(workspaceId).length, missionsBeforeResume);
  assert.notDeepEqual(resumed!.taskIds, pausedMission!.taskIds, "resume must materialize a fresh attempt");
  assert.ok(resumed!.taskIds.every((taskId) => chef.repository.getTask(taskId)?.status === "completed"));

  // Cancel owns task/session teardown and remains terminal after the caller settles.
  const cancelledExecution = chef.sendUserMessage("cancel this mission");
  const cancellable = await eventually(
    () => chef.repository.listMissions(workspaceId).find((mission) => mission.goal === "cancel this mission"),
    (mission) => mission?.status === "active", "active cancellable Mission",
  );
  await eventually(
    () => chef.repository.listSessions(workspaceId).find((session) => cancellable!.taskIds.includes(session.taskId) && session.status === "running"),
    (session) => session !== undefined, "cancellable Mission session",
  );
  await chef.cancelMission(cancellable!.id);
  await cancelledExecution;
  assert.equal(chef.repository.getMission(cancellable!.id)?.status, "cancelled", "aborted execution must not overwrite cancelled state");
  assert.ok(cancellable!.taskIds.every((taskId) => chef.repository.getTask(taskId)?.status === "cancelled"));

  // Redirect cancels the old attempt and completes a new plan on the same Mission.
  pauseHarness.autoExit = false;
  const redirectExecution = chef.sendUserMessage("pause before redirect");
  const redirectable = await eventually(
    () => chef.repository.listMissions(workspaceId).find((mission) => mission.goal === "pause before redirect"),
    (mission) => mission?.status === "active", "active redirectable Mission",
  );
  await eventually(
    () => chef.repository.listSessions(workspaceId).find((session) => redirectable!.taskIds.includes(session.taskId) && session.status === "running"),
    (session) => session !== undefined, "redirectable Mission session",
  );
  const originalTaskIds = [...redirectable!.taskIds];
  await chef.redirectMission(redirectable!.id, "redirected mission outcome");
  await redirectExecution;
  const redirected = await eventually(() => chef.repository.getMission(redirectable!.id), (mission) => mission?.status === "completed", "redirected Mission completion");
  assert.equal(redirected!.goal, "redirected mission outcome");
  assert.notDeepEqual(redirected!.taskIds, originalTaskIds);
  assert.ok(originalTaskIds.every((taskId) => chef.repository.getTask(taskId)?.status === "cancelled"));
  assert.ok(redirected!.taskIds.every((taskId) => chef.repository.getTask(taskId)?.status === "completed"));

  // Two redirects racing through old-task teardown are ordered by explicit
  // attempt epochs. The interrupted first redirect must not become terminal
  // while the second redirect is claiming the same Mission.
  pauseHarness.autoExit = false;
  redirectedHarness.autoExit = false;
  const doubleRedirectExecution = chef.sendUserMessage("pause before double redirect");
  const doubleRedirectMission = await eventually(
    () => chef.repository.listMissions(workspaceId).find((mission) => mission.goal === "pause before double redirect"),
    (mission) => mission?.status === "active", "double-redirect Mission",
  );
  await eventually(
    () => chef.repository.listSessions(workspaceId).find((session) => doubleRedirectMission!.taskIds.includes(session.taskId) && session.status === "running"),
    (session) => session !== undefined, "double-redirect original session",
  );
  await chef.redirectMission(doubleRedirectMission!.id, "redirected superseded live goal");
  await doubleRedirectExecution;
  const supersededAttempt = await eventually(
    () => chef.repository.getMission(doubleRedirectMission!.id),
    (mission) => mission?.status === "active" && mission.goal === "redirected superseded live goal",
    "first redirected attempt",
  );
  await eventually(
    () => chef.repository.listSessions(workspaceId).find((session) => supersededAttempt!.taskIds.includes(session.taskId) && session.status === "running"),
    (session) => session !== undefined, "first redirected live session",
  );
  redirectedHarness.autoExit = true;
  await chef.redirectMission(doubleRedirectMission!.id, "redirected latest goal");
  const latestMission = await eventually(
    () => chef.repository.getMission(doubleRedirectMission!.id),
    (mission) => mission?.status === "completed", "winning redirected Mission completion",
  );
  assert.equal(latestMission!.goal, "redirected latest goal");
  const latestPlan = chef.repository.listPlans(workspaceId).find((plan) => plan.id === latestMission!.planId);
  assert.equal(latestPlan?.goal, "redirected latest goal", "stale redirected plan must not claim Mission ownership");

  console.log("product-runtime-v02-lifecycle: ok — live lifecycle behavior is runtime-owned");
} finally {
  try { await chef.close(); } catch { /* already closed */ }
  await rm(dir, { recursive: true, force: true });
}
