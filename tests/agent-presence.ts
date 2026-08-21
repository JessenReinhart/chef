/**
 * Agent Presence V1 acceptance coverage.
 *
 * Proves that durable agent identity survives independently of a live Session,
 * while task/session/approval/Mission/artifact records compose into one read-only
 * presence projection for the UI.
 */
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createChef } from "../src/main.ts";
import { createHttpServer } from "../src/server/http-server.ts";
import { buildAgentPresence } from "../src/runtime/agent-presence.ts";

const dir = await mkdtemp(join(tmpdir(), "chef-agent-presence-"));
const chef = createChef({ dbPath: join(dir, "chef.sqlite"), projectDir: dir });

try {
  await chef.start();
  const workspaceId = chef.workspaceId;

  // Durable identity needs neither a Task nor a Session.
  chef.repository.upsertCanvasNode({
    id: "agent-alpha",
    workspaceId,
    label: "Agent Alpha",
    kind: "agent",
    harnessId: "claude-code",
    liveStatus: "idle",
    config: { role: "Researcher" },
    position: { x: 100, y: 100 },
  });

  let presence = buildAgentPresence(await chef.inspectState());
  let alpha = presence.find((item) => item.nodeId === "agent-alpha");
  assert.ok(alpha, "a durable canvas agent must always project presence");
  assert.equal(alpha!.status, "idle");
  assert.equal(alpha!.role, "Researcher");
  assert.equal(alpha!.harnessId, "claude-code");
  assert.equal(alpha!.currentTaskId, undefined);
  assert.equal(alpha!.currentSessionId, undefined);
  assert.equal(alpha!.recentArtifact, undefined);
  assert.equal(alpha!.needsAttention, false);

  const mission = chef.repository.insertMission({
    id: "presence-mission",
    workspaceId,
    goal: "Investigate checkout race",
    status: "active",
  });
  const task = chef.repository.createTask({
    id: "presence-task",
    workspaceId,
    title: "Trace the checkout race",
    description: "Find the race condition and report the root cause.",
    status: "running",
    assignedTo: "agent-alpha",
    missionId: mission.id,
    dependencies: [],
    contextRefs: [],
  });
  chef.repository.upsertCanvasNode({
    id: "agent-alpha",
    workspaceId,
    taskId: task.id,
    label: "Agent Alpha",
    kind: "agent",
    harnessId: "claude-code",
    liveStatus: "idle",
    config: { role: "Researcher" },
    position: { x: 100, y: 100 },
  });
  const session = chef.repository.insertSession({
    id: "presence-session",
    workspaceId,
    harnessId: "claude-code",
    agentId: "agent-alpha",
    taskId: task.id,
    pid: 4242,
    status: "running",
    command: "claude",
    args: [],
    cwd: dir,
  });
  chef.repository.appendEvent({
    workspaceId,
    source: { type: "agent", id: "agent-alpha" },
    type: "agent.working",
    payload: { taskId: task.id },
    taskId: task.id,
    sessionId: session.id,
  });
  chef.repository.insertArtifact({
    id: "presence-artifact-draft",
    workspaceId,
    type: "research",
    name: "Checkout trace draft",
    uri: "file:///checkout-trace-draft.md",
    version: 1,
    createdBy: "agent-alpha",
    taskId: task.id,
    sessionId: session.id,
  });
  chef.repository.insertArtifact({
    id: "presence-artifact-final",
    workspaceId,
    type: "result",
    name: "Checkout race finding",
    uri: "file:///checkout-race-finding.md",
    version: 2,
    createdBy: "agent-alpha",
    taskId: task.id,
    sessionId: session.id,
  });
  chef.repository.insertArtifact({
    id: "presence-artifact-unrelated",
    workspaceId,
    type: "document",
    name: "Other agent output",
    uri: "file:///other-agent-output.md",
    createdBy: "agent-beta",
  });

  presence = buildAgentPresence(await chef.inspectState());
  alpha = presence.find((item) => item.nodeId === "agent-alpha");
  assert.equal(alpha?.status, "working", "running session must surface working presence");
  assert.equal(alpha?.currentObjective, "Trace the checkout race");
  assert.equal(alpha?.currentMissionId, mission.id);
  assert.equal(alpha?.missionGoal, mission.goal);
  assert.equal(alpha?.currentSessionId, session.id);
  assert.equal(alpha?.lastActivity?.type, "agent.working");
  assert.deepEqual(alpha?.recentArtifact, {
    id: "presence-artifact-final",
    name: "Checkout race finding",
    type: "result",
    version: 2,
    taskId: task.id,
    sessionId: session.id,
  }, "presence must show the newest durable output associated with the agent work");

  // Human approval has higher semantic priority than an underlying live
  // process: this is the state the human needs to see and act on.
  const approval = chef.repository.insertApproval({
    id: "presence-approval",
    workspaceId,
    taskId: task.id,
    status: "pending",
    requester: "orchestrator",
    reason: "Review destructive change",
  });
  chef.repository.updateTask(task.id, { approvalId: approval.id });
  presence = buildAgentPresence(await chef.inspectState());
  alpha = presence.find((item) => item.nodeId === "agent-alpha");
  assert.equal(alpha?.status, "waiting_for_approval");
  assert.equal(alpha?.needsAttention, true);

  // Once work is terminal, the process may be historical but the agent
  // remains a living workspace identity and returns to Idle. The most recent
  // produced artifact remains useful history for the persistent identity.
  chef.repository.resolveApproval(approval.id, "accepted", "human");
  chef.repository.updateTask(task.id, { status: "completed" });
  chef.repository.updateSession(session.id, { status: "completed", endedAt: Date.now(), exitCode: 0 });
  presence = buildAgentPresence(await chef.inspectState());
  alpha = presence.find((item) => item.nodeId === "agent-alpha");
  assert.equal(alpha?.status, "idle");
  assert.equal(alpha?.currentTaskId, undefined, "completed task is history, not current responsibility");
  assert.equal(alpha?.currentSessionId, undefined, "completed session is history, not live presence");
  assert.equal(alpha?.recentArtifact?.id, "presence-artifact-final");
  assert.ok(alpha, "agent identity must remain after its session ends");

  // HTTP is a projection over the same runtime state, not a second store.
  const server = createHttpServer(chef);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${address.port}/api/agents/presence`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { ok: boolean; data: Array<{ nodeId: string; status: string; recentArtifact?: { id: string } }> };
  assert.equal(body.ok, true);
  const httpAlpha = body.data.find((item) => item.nodeId === "agent-alpha");
  assert.equal(httpAlpha?.status, "idle");
  assert.equal(httpAlpha?.recentArtifact?.id, "presence-artifact-final");
  await new Promise<void>((resolve) => server.close(() => resolve()));

  await chef.close();
  console.log("agent-presence: ok — durable identity composes runtime presence and recent output");
} finally {
  try {
    await chef.close();
  } catch {
    // successful path may already have closed the runtime
  }
  await rm(dir, { recursive: true, force: true });
}
