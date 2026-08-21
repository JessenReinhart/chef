import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createChef } from "../src/main.ts";
import { Repository } from "../src/persistence/database.ts";
import { createHttpServer } from "../src/server/http-server.ts";
import { createContextScopeServer } from "../src/server/context-scope-http.ts";

const dir = await mkdtemp(join(tmpdir(), "chef-v02-http-"));
const dbPath = join(dir, "chef.sqlite");
const runtime = createChef({ dbPath, projectDir: dir });
const server = createContextScopeServer(runtime, createHttpServer(runtime));

const request = async (path: string, body?: unknown, method?: string) => {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() as Record<string, unknown> };
};

try {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const capabilities = await request("/api/capabilities?role=engineer");
  assert.equal(capabilities.status, 200);
  const projectedPolicy = (capabilities.json.data as { role: string; policy: Record<string, string> });
  assert.equal(projectedPolicy.role, "engineer");
  assert.equal(projectedPolicy.policy.terminal, "allow");
  assert.equal(projectedPolicy.policy.browser, "deny");
  assert.equal(projectedPolicy.policy.deploy, "approval", "Power Mode must receive authoritative permission modes");
  assert.equal((await request("/api/capabilities?role=unknown")).status, 400);

  const first = await request("/api/nodes", { type: "agent", title: "Alpha", kind: "agent" });
  const second = await request("/api/nodes", { type: "agent", title: "Beta", kind: "agent" });
  const firstId = (first.json.data as { taskId: string }).taskId;
  const secondId = (second.json.data as { taskId: string }).taskId;

  const edge = await request("/api/edges", { source: firstId, target: secondId, type: "communication" });
  assert.equal(edge.status, 201);
  assert.equal((edge.json.data as { type: string }).type, "communication");
  assert.deepEqual(runtime.repository.getTask(secondId)?.dependencies, [], "communication must not imply ordering");

  assert.equal((await request("/api/edges", { source: firstId, target: secondId, type: "dependency" })).status, 201);
  assert.deepEqual(runtime.repository.getTask(secondId)?.dependencies, [firstId]);
  assert.equal((await request(`/api/edges/${encodeURIComponent(`${firstId}->${secondId}:communication`)}`, undefined, "DELETE")).status, 200);
  assert.equal(runtime.listCanvas(runtime.workspaceId).edges.some((item) => item.source === firstId && item.target === secondId && item.type === "communication"), false);
  assert.equal(runtime.listCanvas(runtime.workspaceId).edges.some((item) => item.source === firstId && item.target === secondId && item.type === "dependency"), true, "typed deletion must preserve sibling relationships");
  assert.deepEqual(runtime.repository.getTask(secondId)?.dependencies, [firstId], "deleting communication must preserve dependency ordering");
  assert.equal((await request(`/api/edges/${encodeURIComponent(`${firstId}->${secondId}:dependency`)}`, undefined, "DELETE")).status, 200);
  assert.deepEqual(runtime.repository.getTask(secondId)?.dependencies, [], "deleting dependency must remove ordering");

  const zoneRef = { type: "artifact", id: "zone-owned-ref", relevance: 1 };
  const zoneCreated = await request("/api/context-scopes", {
    id: "http-zone", name: "HTTP Zone", bounds: { x: 0, y: 0, width: 100, height: 100 },
    memberNodeIds: [firstId], contextRefs: [zoneRef], policy: { sharing: "members" },
  });
  assert.equal(zoneCreated.status, 201);
  assert.deepEqual(runtime.repository.getTask(firstId)?.contextRefs, [zoneRef], "Context Zone refs must reach explicit members");
  assert.equal((await request("/api/context-scopes/http-zone", undefined, "DELETE")).status, 200);
  assert.deepEqual(runtime.repository.getTask(firstId)?.contextRefs, [], "deleting a Context Zone must retract its owned refs");
  assert.equal((await request("/api/context-scopes", {
    name: "Invalid Zone", bounds: { x: 0, y: 0, width: 1, height: 1 }, memberNodeIds: ["missing-node"],
  })).status, 400, "Context Zone members must belong to the workspace graph");

  const missionCount = runtime.repository.listMissions(runtime.workspaceId).length;
  const activated = await request(`/api/nodes/${firstId}/activate`, {});
  assert.equal((activated.json.data as { liveStatus: string }).liveStatus, "idle");
  assert.equal(runtime.repository.listMissions(runtime.workspaceId).length, missionCount);
  assert.equal((await request(`/api/nodes/${firstId}/message`, { message: "Please inspect this directly" })).status, 202);
  assert.ok(runtime.repository.listEvents(runtime.workspaceId).some((event) => event.type === "user.intervention"));

  const mission = runtime.repository.insertMission({
    id: "http-mission",
    workspaceId: runtime.workspaceId,
    goal: "Ship a trustworthy result",
    createdBy: "user",
    metadata: { priority: "high" },
  });
  const criteriaUpdated = await request(`/api/missions/${mission.id}/success-criteria`, {
    successCriteria: ["  Tests pass  ", "Review evidence is attached"],
  }, "PUT");
  assert.equal(criteriaUpdated.status, 200);
  const updatedMission = (criteriaUpdated.json.data as { goal: string; metadata: Record<string, unknown> });
  assert.equal(updatedMission.goal, mission.goal, "editing success criteria must not redirect the Mission");
  assert.equal(updatedMission.metadata.priority, "high", "Mission metadata updates must preserve unrelated keys");
  assert.deepEqual(updatedMission.metadata.successCriteria, ["Tests pass", "Review evidence is attached"]);
  assert.ok(runtime.repository.listEvents(runtime.workspaceId).some((event) =>
    event.type === "mission.success_criteria.updated"
      && (event.payload as { missionId?: string }).missionId === mission.id
  ), "success-criteria edits should remain visible in Mission history");
  assert.equal((await request(`/api/missions/${mission.id}/success-criteria`, { successCriteria: ["valid", "   "] }, "PUT")).status, 400);
  assert.equal((await request(`/api/missions/${mission.id}/success-criteria`, { successCriteria: "not-an-array" }, "PUT")).status, 400);
  const criteriaCleared = await request(`/api/missions/${mission.id}/success-criteria`, { successCriteria: [] }, "PUT");
  assert.equal(criteriaCleared.status, 200);
  assert.deepEqual((criteriaCleared.json.data as { metadata: Record<string, unknown> }).metadata.successCriteria, [], "an empty list should explicitly clear success criteria");

  const created = await request("/api/automations", {
    name: "Repeatable check", nodeIds: [firstId, secondId],
    edges: [{ source: firstId, target: secondId, type: "control" }],
  });
  const automationId = (created.json.data as { id: string }).id;
  const started = await request(`/api/automations/${automationId}/run`, {});
  assert.equal(started.status, 200);
  const runTaskIds = (started.json.data as { taskIds: string[] }).taskIds;
  assert.equal(runTaskIds.length, 2, "an Automation run must materialize its executable steps");
  assert.ok(runTaskIds.every((taskId) => runtime.repository.getTask(taskId)?.automationId === automationId));
  assert.equal((await request(`/api/automations/${automationId}/stop`, {})).status, 200);
  assert.ok(runTaskIds.every((taskId) => runtime.repository.getTask(taskId)?.status === "cancelled"));

  await runtime.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

  // Simulate a v0.1 canvas_edges table and prove Repository rebuilds its
  // pair-only uniqueness into typed relationship uniqueness on reopen.
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    DROP TABLE canvas_edges;
    CREATE TABLE canvas_edges (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, source TEXT NOT NULL, target TEXT NOT NULL,
      source_handle TEXT, target_handle TEXT, updated_at INTEGER NOT NULL, UNIQUE(source, target)
    );
    INSERT INTO canvas_edges VALUES ('legacy', '${runtime.workspaceId}', '${firstId}', '${secondId}', NULL, NULL, 1);
  `);
  raw.close();
  const migrated = new Repository(dbPath);
  migrated.upsertCanvasEdge({ workspaceId: runtime.workspaceId, source: firstId, target: secondId, type: "communication" });
  migrated.upsertCanvasEdge({ workspaceId: runtime.workspaceId, source: firstId, target: secondId, type: "dependency" });
  assert.deepEqual(migrated.listCanvasEdges(runtime.workspaceId).map((item) => item.type).sort(), ["communication", "context", "dependency"]);
  migrated.close();
  console.log("product-runtime-v02-http: ok");
} finally {
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  try { await runtime.close(); } catch { /* already closed */ }
  await rm(dir, { recursive: true, force: true });
}
