import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createChef } from "../src/main.ts";
import { createHttpServer } from "../src/server/http-server.ts";
import { createArtifactServer } from "../src/server/artifact-http.ts";

const dir = await mkdtemp(join(tmpdir(), "chef-artifact-http-"));
const runtime = createChef({ dbPath: join(dir, "chef.sqlite"), projectDir: dir });
const server = createArtifactServer(runtime, createHttpServer(runtime));

const request = async (path: string) => {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
  return { status: response.status, json: await response.json() as { ok?: boolean; data?: unknown; error?: string } };
};

try {
  const mission = runtime.repository.insertMission({
    id: "mission-monthly-close",
    workspaceId: runtime.workspaceId,
    goal: "Produce and verify the monthly close report",
    status: "active",
    taskIds: ["task-report", "task-verification"],
  });
  const otherMission = runtime.repository.insertMission({
    id: "mission-other",
    workspaceId: runtime.workspaceId,
    goal: "Prepare a separate analysis",
    status: "active",
    taskIds: ["task-other"],
  });

  const report = runtime.repository.insertArtifact({
    id: "artifact-report",
    workspaceId: runtime.workspaceId,
    type: "document",
    name: "Monthly report",
    uri: "file:///reports/monthly.pdf",
    version: 2,
    createdBy: "analyst",
    taskId: "task-report",
    metadata: { format: "pdf", reviewed: true },
  });
  runtime.repository.insertArtifact({
    id: "artifact-result",
    workspaceId: runtime.workspaceId,
    type: "result",
    name: "Verification result",
    uri: "sideband://verification/result.json",
    createdBy: "verifier",
    taskId: "task-verification",
    metadata: { passed: true },
  });
  runtime.repository.insertArtifact({
    id: "artifact-other-mission",
    workspaceId: runtime.workspaceId,
    type: "research",
    name: "Separate analysis",
    uri: "file:///analysis/other.md",
    createdBy: "analyst",
    taskId: "task-other",
  });
  runtime.repository.insertArtifact({
    id: "artifact-unscoped",
    workspaceId: runtime.workspaceId,
    type: "file",
    name: "Workspace reference",
    uri: "file:///references/source.csv",
    createdBy: "user",
  });

  const otherWorkspace = runtime.repository.createWorkspace({ name: "Other workspace" });
  const foreignMission = runtime.repository.insertMission({
    id: "foreign-mission",
    workspaceId: otherWorkspace.id,
    goal: "Private workspace work",
    taskIds: ["foreign-task"],
  });
  runtime.repository.insertArtifact({
    id: "artifact-private-to-other-workspace",
    workspaceId: otherWorkspace.id,
    type: "document",
    name: "Other report",
    uri: "file:///other/report.pdf",
    createdBy: "analyst",
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const list = await request("/api/artifacts");
  assert.equal(list.status, 200);
  const artifacts = list.json.data as Array<{ id: string }>;
  assert.deepEqual(artifacts.map((artifact) => artifact.id), ["artifact-report", "artifact-result", "artifact-other-mission", "artifact-unscoped"]);

  const documents = await request("/api/artifacts?type=document&createdBy=analyst");
  assert.equal(documents.status, 200);
  assert.deepEqual((documents.json.data as Array<{ id: string }>).map((artifact) => artifact.id), ["artifact-report"]);

  const missionArtifacts = await request(`/api/artifacts?missionId=${encodeURIComponent(mission.id)}`);
  assert.equal(missionArtifacts.status, 200);
  assert.deepEqual((missionArtifacts.json.data as Array<{ id: string }>).map((artifact) => artifact.id), ["artifact-report", "artifact-result"]);

  const missionDocuments = await request(`/api/artifacts?missionId=${encodeURIComponent(mission.id)}&type=document&createdBy=analyst`);
  assert.equal(missionDocuments.status, 200);
  assert.deepEqual((missionDocuments.json.data as Array<{ id: string }>).map((artifact) => artifact.id), ["artifact-report"]);

  const otherMissionArtifacts = await request(`/api/artifacts?missionId=${encodeURIComponent(otherMission.id)}`);
  assert.equal(otherMissionArtifacts.status, 200);
  assert.deepEqual((otherMissionArtifacts.json.data as Array<{ id: string }>).map((artifact) => artifact.id), ["artifact-other-mission"]);

  const unknownMission = await request("/api/artifacts?missionId=not-here");
  assert.equal(unknownMission.status, 404);
  assert.match(unknownMission.json.error ?? "", /mission not found/);

  const foreignMissionArtifacts = await request(`/api/artifacts?missionId=${encodeURIComponent(foreignMission.id)}`);
  assert.equal(foreignMissionArtifacts.status, 404);
  assert.match(foreignMissionArtifacts.json.error ?? "", /mission not found/);

  const detail = await request(`/api/artifacts/${encodeURIComponent(report.id)}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.json.data, JSON.parse(JSON.stringify(report)));

  const missing = await request("/api/artifacts/not-here");
  assert.equal(missing.status, 404);
  assert.match(missing.json.error ?? "", /artifact not found/);

  const invalidType = await request("/api/artifacts?type=executable");
  assert.equal(invalidType.status, 400);
  assert.match(invalidType.json.error ?? "", /type must be one of/);

  // Wrapper must preserve every existing base-server route.
  const state = await request("/api/state");
  assert.equal(state.status, 200);
  assert.ok(Array.isArray((state.json as Record<string, unknown>).artifacts));

  console.log("artifact-http: ok");
} finally {
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  await runtime.close();
  await rm(dir, { recursive: true, force: true });
}
