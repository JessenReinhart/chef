/**
 * Product/runtime v0.2 acceptance coverage.
 *
 * Exercises durable runtime contracts without depending on the disposable UI:
 * missions, typed workspace relationships, explicit Context Zone membership,
 * automations, and live surfaces that exist outside Mission execution.
 */
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createChef } from "../src/main.ts";
import type {
  Decision,
  DecisionProvider,
  Plan,
  PlanProposalContext,
  PlanTaskOutcome,
} from "../src/core/types.ts";

class EmptyPlanProvider implements DecisionProvider {
  readonly name = "v02-empty-plan";

  async proposePlan(input: PlanProposalContext): Promise<Plan> {
    return {
      id: "v02-plan",
      workspaceId: input.workspaceId,
      goal: input.goal,
      status: "proposed",
      tasks: [],
      taskIds: [],
      createdAt: Date.now(),
    };
  }

  async evaluate(_taskResult: PlanTaskOutcome): Promise<Decision> {
    throw new Error("an empty plan has no task outcomes to evaluate");
  }
}

const dir = await mkdtemp(join(tmpdir(), "chef-product-runtime-v02-"));
const dbPath = join(dir, "chef.sqlite");
const provider = new EmptyPlanProvider();
let chef = createChef({ dbPath, projectDir: dir, decisionProvider: provider });

try {
  await chef.start();
  const workspaceId = chef.workspaceId;

  // Human intent creates a Mission and drives its durable lifecycle. An empty
  // plan keeps this test focused on orchestration state rather than PTY setup.
  const result = await chef.sendUserMessage("Prove the v0.2 mission lifecycle");
  assert.equal(result.ok, true, result.report);

  let snapshot = await chef.inspectState();
  assert.equal(snapshot.missions.length, 1, "human intent must create exactly one Mission");
  const mission = snapshot.missions[0];
  assert.equal(mission.goal, "Prove the v0.2 mission lifecycle");
  assert.equal(mission.status, "completed", "successful orchestration must complete the Mission");
  assert.equal(mission.planId, "v02-plan", "Mission must retain its durable plan link");
  assert.deepEqual(mission.taskIds, [], "Mission task lineage must match its plan");
  assert.ok(mission.completedAt, "terminal Mission state must record completion time");
  assert.equal(snapshot.plans[0].missionId, mission.id, "plan must link back to its Mission");
  const missionEvents = snapshot.events.filter((event) => {
    const payload = event.payload as { missionId?: string };
    return payload.missionId === mission.id;
  });
  assert.ok(missionEvents.some((event) => event.type === "mission.created"), "Mission creation must be observable");
  assert.ok(missionEvents.some((event) => event.type === "mission.status" && event.payload.status === "active"), "Mission activation must be observable");
  assert.ok(missionEvents.some((event) => event.type === "mission.status" && event.payload.status === "completed"), "Mission completion must be observable");

  // Explicit lifecycle controls remain durable independently of the scripted
  // orchestrator path (pause/resume/cancel are Mission-scoped operations).
  const controlledMission = chef.repository.insertMission({
    id: "controlled-mission",
    workspaceId,
    goal: "Pause, resume, then cancel safely",
    status: "active",
  });
  assert.equal(chef.repository.updateMission(controlledMission.id, { status: "paused" }).status, "paused");
  assert.equal(chef.repository.updateMission(controlledMission.id, { status: "active" }).status, "active");
  const cancelledMission = chef.repository.updateMission(controlledMission.id, { status: "cancelled" });
  assert.equal(cancelledMission.status, "cancelled");
  assert.ok(cancelledMission.completedAt, "cancelled Mission must have a terminal timestamp");

  // A communication relationship is durable relationship state, not an
  // implicit task dependency. Multiple semantic edges may connect one pair.
  chef.repository.upsertCanvasNode({
    id: "agent-alpha",
    workspaceId,
    label: "Agent Alpha",
    kind: "agent",
    liveStatus: "idle",
    config: { surface: "terminal", command: "node" },
    position: { x: 900, y: 900 },
  });
  chef.repository.upsertCanvasNode({
    id: "agent-beta",
    workspaceId,
    label: "Agent Beta",
    kind: "agent",
    liveStatus: "offline",
    position: { x: 40, y: 40 },
  });
  chef.repository.upsertCanvasEdge({ workspaceId, source: "agent-alpha", target: "agent-beta", type: "communication" });
  chef.repository.upsertCanvasEdge({ workspaceId, source: "agent-alpha", target: "agent-beta", type: "dependency" });
  const semanticEdges = chef.repository.listCanvasEdges(workspaceId).filter(
    (edge) => edge.source === "agent-alpha" && edge.target === "agent-beta",
  );
  assert.deepEqual(
    semanticEdges.map((edge) => edge.type).sort(),
    ["communication", "dependency"],
    "communication and dependency must remain distinct typed relationships",
  );
  assert.equal(
    chef.repository.getTask("agent-beta"),
    null,
    "a communication edge must not manufacture a sequential Task dependency",
  );

  // Context Zone membership is explicit. Geometry deliberately contradicts
  // membership: alpha is outside the zone and beta is inside, but alpha alone
  // remains the member, even when bounds change without a membership patch.
  const zone = chef.repository.upsertContextZone({
    id: "zone-project",
    workspaceId,
    name: "Project context",
    bounds: { x: 0, y: 0, width: 200, height: 200 },
    memberNodeIds: ["agent-alpha"],
    contextRefs: [{ type: "task", id: "shared-brief", relevance: 1 }],
    policy: { sharing: "members" },
  });
  assert.deepEqual(zone.memberNodeIds, ["agent-alpha"]);
  const movedZone = chef.repository.upsertContextZone({
    id: zone.id,
    workspaceId,
    name: zone.name,
    bounds: { x: 500, y: 500, width: 50, height: 50 },
    contextRefs: zone.contextRefs,
    policy: zone.policy,
  });
  assert.deepEqual(movedZone.memberNodeIds, ["agent-alpha"], "geometry changes must not infer or erase membership");

  // Run/Stop and history belong to explicit Automation definitions.
  const automation = chef.repository.insertAutomation({
    id: "monthly-report",
    workspaceId,
    name: "Monthly report",
    description: "Repeatable report generation",
    nodeIds: ["collect", "publish"],
    edges: [{ source: "collect", target: "publish", type: "dependency" }],
    trigger: { type: "manual" },
  });
  assert.equal(automation.status, "idle");
  const run = chef.repository.runAutomation(automation.id);
  assert.equal(run.status, "running");
  assert.equal(chef.repository.getAutomation(automation.id)?.currentRunId, run.id);
  assert.throws(() => chef.repository.runAutomation(automation.id), /already running/);
  const stoppedRun = chef.repository.stopAutomation(automation.id);
  assert.equal(stoppedRun.id, run.id);
  assert.equal(stoppedRun.status, "cancelled");
  assert.ok(stoppedRun.endedAt, "stopped run must retain its end time");
  assert.equal(chef.repository.getAutomation(automation.id)?.status, "stopped");
  assert.deepEqual(chef.repository.listAutomationRuns(automation.id).map((item) => item.id), [run.id]);

  // A live interactive surface can be activated without creating or joining a
  // Mission. Its node state/config are durable workspace state of their own.
  const missionCountBeforeActivation = chef.repository.listMissions(workspaceId).length;
  chef.repository.upsertCanvasNode({
    id: "agent-alpha",
    workspaceId,
    label: "Agent Alpha",
    kind: "agent",
    liveStatus: "starting",
    config: { surface: "terminal", command: "node" },
    position: { x: 900, y: 900 },
  });
  chef.repository.upsertCanvasNode({
    id: "agent-alpha",
    workspaceId,
    label: "Agent Alpha",
    kind: "agent",
    liveStatus: "idle",
    config: { surface: "terminal", command: "node" },
    position: { x: 900, y: 900 },
  });
  const liveNode = chef.repository.listCanvasNodes(workspaceId).find((node) => node.id === "agent-alpha");
  assert.equal(liveNode?.liveStatus, "idle");
  assert.deepEqual(liveNode?.config, { surface: "terminal", command: "node" });
  assert.equal(chef.repository.listMissions(workspaceId).length, missionCountBeforeActivation, "surface activation must not create a Mission");

  const durableArtifact = chef.repository.insertArtifact({
    id: "v02-artifact",
    workspaceId,
    type: "document",
    name: "Mission outcome",
    uri: "workspace://artifacts/mission-outcome",
    createdBy: "orchestrator",
    metadata: { missionId: mission.id },
  });
  const durableDecision = chef.repository.insertDecision({
    id: "v02-decision",
    workspaceId,
    type: "mission.verification",
    summary: "The v0.2 outcome is verified",
    payload: { missionId: mission.id, artifactId: durableArtifact.id },
    madeBy: "orchestrator",
    timestamp: Date.now(),
    status: "accepted",
  });

  await chef.close();

  // The product runtime is restart-safe: all v0.2 state must be recoverable
  // from SQLite, not from in-memory UI or orchestrator objects.
  chef = createChef({ dbPath, projectDir: dir, decisionProvider: provider });
  await chef.start();
  snapshot = await chef.inspectState();
  assert.equal(snapshot.missions.find((item) => item.id === mission.id)?.status, "completed");
  assert.equal(snapshot.missions.find((item) => item.id === controlledMission.id)?.status, "cancelled");
  assert.deepEqual(
    snapshot.canvasEdges.filter((edge) => edge.source === "agent-alpha" && edge.target === "agent-beta").map((edge) => edge.type).sort(),
    ["communication", "dependency"],
  );
  assert.deepEqual(snapshot.contextZones.find((item) => item.id === zone.id)?.memberNodeIds, ["agent-alpha"]);
  assert.equal(snapshot.automations.find((item) => item.id === automation.id)?.status, "stopped");
  assert.equal(snapshot.automationRuns.find((item) => item.id === run.id)?.status, "cancelled");
  assert.equal(snapshot.artifacts.find((item) => item.id === durableArtifact.id)?.uri, durableArtifact.uri);
  assert.equal(snapshot.decisions.find((item) => item.id === durableDecision.id)?.status, "accepted");
  const restoredLiveNode = snapshot.canvasNodes.find((node) => node.id === "agent-alpha");
  assert.equal(restoredLiveNode?.liveStatus, "idle");
  assert.equal(restoredLiveNode?.taskId, null, "live surface must remain independent of Mission tasks");

  // The two presentation requirements have no DOM test harness in this
  // repository, so keep their acceptance checks deliberately static and
  // narrow: Run is Automation-scoped and both modes receive the same state.
  const appSource = await readFile(join(process.cwd(), "web", "src", "App.tsx"), "utf8");
  const paletteSource = await readFile(join(process.cwd(), "web", "src", "NodePalette.tsx"), "utf8");
  assert.doesNotMatch(appSource, />\s*Run\s*</, "the living workspace must not expose a global Run action");
  assert.match(appSource, /aria-label="Automation controls"[\s\S]*Run automation/, "Run must be scoped to Automation controls");
  assert.match(
    appSource,
    /<BlueprintCanvas[\s\S]*tasks=\{tasks\}[\s\S]*canvasNodes=\{canvasNodes\}[\s\S]*canvasEdges=\{canvasEdges\}[\s\S]*mode=\{mode\}/,
    "Simple and Power modes must disclose the same underlying runtime state",
  );
  assert.match(paletteSource, /mode === "power" && entry\.harnessId/, "Simple Mode must hide harness internals");
  assert.match(paletteSource, /mode === "simple" \? SIMPLE_CATEGORY_LABELS/, "Simple Mode must use friendly workspace language");

  await chef.close();
  console.log("product-runtime-v02: ok — living workspace contracts survive restart");
} finally {
  try {
    await chef.close();
  } catch {
    // The runtime may already be closed after the successful path.
  }
  await rm(dir, { recursive: true, force: true });
}
