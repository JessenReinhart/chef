import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Repository } from "../src/persistence/database.ts";
import { Scheduler, type HarnessRegistry } from "../src/runtime/scheduler.ts";
import { reconcileInterruptedMissions } from "../src/runtime/startup-recovery.ts";

const dir = await mkdtemp(join(tmpdir(), "chef-startup-recovery-"));
const dbPath = join(dir, "chef.sqlite");
const workspaceId = "workspace-a";

const emptyRegistry: HarnessRegistry = {
  get: () => undefined,
  set: () => {},
  values: () => [],
};

function seedMission(
  repo: Repository,
  input: {
    missionId: string;
    planId: string;
    taskId: string;
    sessionId?: string;
    missionStatus: "active" | "verifying" | "completed";
    planStatus: "executing" | "completed";
    taskStatus?: "pending" | "running" | "completed";
  },
): void {
  repo.insertMission({
    id: input.missionId,
    workspaceId,
    goal: "Create a simple todo app",
    status: "planning",
    taskIds: [],
  });
  repo.insertPlan({
    id: input.planId,
    workspaceId,
    goal: "Create a simple todo app",
    missionId: input.missionId,
    status: input.planStatus,
    tasks: [],
    taskIds: [input.taskId],
  });
  repo.updateMission(input.missionId, {
    status: "active",
    planId: input.planId,
    taskIds: [input.taskId],
  });
  repo.insertTask({
    id: input.taskId,
    workspaceId,
    title: "Build todo app",
    description: "Create and verify the todo app",
    status: input.taskStatus ?? "running",
    assignedTo: "worker",
    missionId: input.missionId,
    dependencies: [],
    contextRefs: [],
    retryCount: 0,
  });
  if (input.sessionId) {
    repo.insertSession({
      id: input.sessionId,
      workspaceId,
      harnessId: "worker",
      agentId: "worker",
      taskId: input.taskId,
      status: "running",
      command: "worker",
      args: [],
      cwd: dir,
    });
  }
  if (input.missionStatus === "verifying") {
    repo.updateMission(input.missionId, { status: "verifying" });
  } else if (input.missionStatus === "completed") {
    repo.updateMission(input.missionId, { status: "completed" });
  }
}

try {
  const seed = new Repository(dbPath);
  seed.createWorkspace({ id: workspaceId, name: "Startup recovery" });

  seed.insertMission({
    id: "planning-mission",
    workspaceId,
    goal: "Create a simple todo app",
    status: "planning",
    taskIds: [],
  });

  seedMission(seed, {
    missionId: "orphan-mission",
    planId: "orphan-plan",
    taskId: "orphan-task",
    sessionId: "orphan-session",
    missionStatus: "active",
    planStatus: "executing",
  });

  seedMission(seed, {
    missionId: "post-worker-mission",
    planId: "post-worker-plan",
    taskId: "post-worker-task",
    missionStatus: "active",
    planStatus: "executing",
    taskStatus: "completed",
  });

  seedMission(seed, {
    missionId: "verifying-mission",
    planId: "verifying-plan",
    taskId: "verified-task",
    missionStatus: "verifying",
    planStatus: "executing",
    taskStatus: "completed",
  });

  seedMission(seed, {
    missionId: "terminal-mission",
    planId: "terminal-plan",
    taskId: "terminal-task",
    sessionId: "terminal-session",
    missionStatus: "completed",
    planStatus: "completed",
  });

  seedMission(seed, {
    missionId: "resumable-mission",
    planId: "resumable-plan",
    taskId: "resumable-task",
    missionStatus: "active",
    planStatus: "executing",
    taskStatus: "pending",
  });

  seed.insertTask({
    id: "standalone-task",
    workspaceId,
    title: "Standalone work",
    description: "Running work without a Mission owner",
    status: "running",
    assignedTo: "worker",
    dependencies: [],
    contextRefs: [],
    retryCount: 0,
  });
  seed.insertSession({
    id: "standalone-session",
    workspaceId,
    harnessId: "worker",
    agentId: "worker",
    taskId: "standalone-task",
    status: "spawning",
    command: "worker",
    args: [],
    cwd: dir,
  });
  seed.close();

  const reopened = new Repository(dbPath);
  reconcileInterruptedMissions(reopened, workspaceId);
  const scheduler = new Scheduler(reopened, emptyRegistry);
  await scheduler.recoverOnStartup(workspaceId);

  assert.equal(
    reopened.getMission("planning-mission")?.status,
    "failed",
    "planning cannot remain live after the in-memory planner disappears on restart",
  );

  const sessions = reopened.listSessions(workspaceId);
  assert.equal(
    sessions.find((session) => session.id === "orphan-session")?.status,
    "crashed",
    "an orphaned Mission worker session must become visibly crashed on startup",
  );
  assert.equal(
    sessions.find((session) => session.id === "standalone-session")?.status,
    "crashed",
    "standalone orphan sessions retain the existing startup recovery behavior",
  );
  assert.equal(reopened.getTask("orphan-task")?.status, "blocked");
  assert.equal(reopened.getTask("standalone-task")?.status, "blocked");

  assert.equal(
    reopened.getMission("orphan-mission")?.status,
    "failed",
    "a Mission cannot remain working after startup recovery proves its worker disappeared",
  );
  assert.equal(
    reopened.getPlan("orphan-plan")?.status,
    "failed",
    "the owning Plan cannot remain executing after its in-flight worker is recovered as orphaned",
  );

  assert.equal(
    reopened.getMission("post-worker-mission")?.status,
    "failed",
    "a Mission cannot remain working after all worker Tasks completed and the in-memory handoff disappeared",
  );
  assert.equal(
    reopened.getPlan("post-worker-plan")?.status,
    "failed",
    "the owning Plan cannot remain executing after the completed worker lost its Mission handoff",
  );
  assert.equal(
    reopened.getTask("post-worker-task")?.status,
    "completed",
    "recovering the post-worker handoff must preserve the durable completed result",
  );

  assert.equal(
    reopened.getMission("verifying-mission")?.status,
    "failed",
    "verification cannot remain live after the in-memory verifier disappears on restart",
  );
  assert.equal(
    reopened.getPlan("verifying-plan")?.status,
    "failed",
    "an interrupted verification must not leave its Plan looking live",
  );
  assert.equal(
    reopened.getTask("verified-task")?.status,
    "completed",
    "recovering interrupted verification must preserve the worker result that already completed",
  );

  assert.equal(
    reopened.getMission("terminal-mission")?.status,
    "completed",
    "startup recovery must never rewrite terminal Mission history even if inconsistent orphan task residue exists",
  );
  assert.equal(reopened.getPlan("terminal-plan")?.status, "completed");
  assert.equal(
    reopened.getMission("resumable-mission")?.status,
    "active",
    "an active Mission with pending work must remain available for normal dispatch after restart",
  );
  assert.equal(reopened.getPlan("resumable-plan")?.status, "executing");
  assert.equal(reopened.getTask("resumable-task")?.status, "pending");

  const startupMissionEvents = reopened.getWorkspaceSnapshot(workspaceId).events.filter(
    (event) => event.type === "mission.status" && event.source.type === "runtime" && event.source.id === "startup-recovery",
  );
  assert.equal(startupMissionEvents.length, 4, "startup recovery must announce each interrupted Mission exactly once");

  const planningRecovery = startupMissionEvents.find(
    (event) => (event.payload as { missionId?: string }).missionId === "planning-mission",
  );
  assert.ok(planningRecovery);
  assert.equal(planningRecovery.taskId, undefined);
  assert.deepEqual(planningRecovery.payload, {
    missionId: "planning-mission",
    status: "failed",
    reason: "planning interrupted before restart",
  });

  const workerRecovery = startupMissionEvents.find(
    (event) => (event.payload as { missionId?: string }).missionId === "orphan-mission",
  );
  assert.ok(workerRecovery);
  assert.equal(workerRecovery.taskId, "orphan-task");
  assert.deepEqual(workerRecovery.payload, {
    missionId: "orphan-mission",
    status: "failed",
    reason: "worker interrupted before restart",
  });

  const postWorkerRecovery = startupMissionEvents.find(
    (event) => (event.payload as { missionId?: string }).missionId === "post-worker-mission",
  );
  assert.ok(postWorkerRecovery);
  assert.equal(postWorkerRecovery.taskId, undefined);
  assert.deepEqual(postWorkerRecovery.payload, {
    missionId: "post-worker-mission",
    status: "failed",
    reason: "worker completed before restart handoff",
  });

  const verificationRecovery = startupMissionEvents.find(
    (event) => (event.payload as { missionId?: string }).missionId === "verifying-mission",
  );
  assert.ok(verificationRecovery);
  assert.equal(verificationRecovery.taskId, undefined);
  assert.deepEqual(verificationRecovery.payload, {
    missionId: "verifying-mission",
    status: "failed",
    reason: "verification interrupted before restart",
  });

  reopened.close();
  console.log("startup-recovery: ok — restart makes interrupted planning, workers, post-worker handoff, and verification truthful without rewriting terminal or resumable history");
} finally {
  await rm(dir, { recursive: true, force: true });
}
