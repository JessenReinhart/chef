import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import type { RuntimeEvent } from "../src/core/types.ts";
import { createMissionTimelineServer, projectMissionTimeline } from "../src/server/mission-timeline-http.ts";

const workspaceId = "workspace-a";
const mission = {
  id: "mission-a",
  workspaceId,
  goal: "Ship the feature",
  status: "active" as const,
  taskIds: ["task-a", "task-b"],
  createdBy: "user",
  metadata: {},
  createdAt: 1,
  updatedAt: 1,
};
const otherWorkspaceMission = { ...mission, id: "foreign-mission", workspaceId: "workspace-b" };

const events: RuntimeEvent[] = [
  { id: "e1", workspaceId, seq: 1, timestamp: 1, source: { type: "mission", id: mission.id }, type: "mission.created", payload: { missionId: mission.id } },
  { id: "e2", workspaceId, seq: 2, timestamp: 2, source: { type: "task", id: "task-a" }, type: "task.status", payload: { status: "running" }, taskId: "task-a" },
  { id: "e3", workspaceId, seq: 3, timestamp: 3, source: { type: "orchestrator", id: "chef" }, type: "plan.revised", payload: { missionId: mission.id, reason: "retry" } },
  { id: "e4", workspaceId, seq: 4, timestamp: 4, source: { type: "task", id: "task-other" }, type: "task.status", payload: { status: "running" }, taskId: "task-other" },
  { id: "e5", workspaceId, seq: 5, timestamp: 5, source: { type: "mission", id: "mission-other" }, type: "mission.status", payload: { missionId: "mission-other" } },
];

assert.deepEqual(projectMissionTimeline(mission, events).map((event) => event.id), ["e1", "e2", "e3"]);

const repository = {
  getMission(id: string) {
    if (id === mission.id) return mission;
    if (id === otherWorkspaceMission.id) return otherWorkspaceMission;
    return null;
  },
  listEvents(id: string) {
    assert.equal(id, workspaceId);
    return events;
  },
};
const runtime = { workspaceId, repository } as never;
const baseServer = createServer((_req, res) => {
  res.writeHead(418, { "content-type": "application/json" });
  res.end(JSON.stringify({ base: true }));
});
const server = createMissionTimelineServer(runtime, baseServer);

const request = async (path: string) => {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
  return { status: response.status, json: await response.json() as { ok?: boolean; data?: RuntimeEvent[]; error?: string; base?: boolean } };
};

try {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const timeline = await request(`/api/missions/${mission.id}/timeline`);
  assert.equal(timeline.status, 200);
  assert.deepEqual(timeline.json.data?.map((event) => event.id), ["e1", "e2", "e3"]);

  const missing = await request("/api/missions/missing/timeline");
  assert.equal(missing.status, 404);
  assert.match(missing.json.error ?? "", /mission not found/);

  const foreign = await request(`/api/missions/${otherWorkspaceMission.id}/timeline`);
  assert.equal(foreign.status, 404, "timeline must not expose another workspace's Mission");

  const fallthrough = await request("/api/state");
  assert.equal(fallthrough.status, 418);
  assert.equal(fallthrough.json.base, true, "unrelated routes must preserve the existing server handler");

  console.log("mission-timeline-http: ok");
} finally {
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
}
