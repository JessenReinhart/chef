import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createChef } from "../src/main.ts";
import { createHttpServer } from "../src/server/http-server.ts";
import { artifactRevealCommand, createArtifactServer } from "../src/server/artifact-http.ts";

const dir = await mkdtemp(join(tmpdir(), "chef-artifact-http-"));
const outsideDir = await mkdtemp(join(tmpdir(), "chef-artifact-http-outside-"));
const runtime = createChef({ dbPath: join(dir, "chef.sqlite"), projectDir: dir });
const revealed: Array<{ path: string; isDirectory: boolean }> = [];
const server = createArtifactServer(runtime, createHttpServer(runtime), {
  revealPath: async (path, isDirectory) => { revealed.push({ path, isDirectory }); },
});

const request = async (path: string, init?: RequestInit) => {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, init);
  return { status: response.status, json: await response.json() as { ok?: boolean; data?: unknown; error?: string } };
};

const requestRaw = async (path: string) => {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return fetch(`http://127.0.0.1:${address.port}${path}`);
};

const revealInit: RequestInit = {
  method: "POST",
  headers: { "x-chef-action": "reveal-artifact" },
};

try {
  assert.deepEqual(
    artifactRevealCommand("C:\\work\\todo-app\\index.html", false, "win32"),
    { command: "explorer.exe", args: ["C:\\work\\todo-app"] },
    "Windows reveal must use explorer without shell interpolation and open the containing folder",
  );
  assert.deepEqual(
    artifactRevealCommand("/work/todo-app/index.html", false, "linux"),
    { command: "xdg-open", args: ["/work/todo-app"] },
    "Linux reveal must use xdg-open without shell interpolation and open the containing folder",
  );
  assert.deepEqual(
    artifactRevealCommand("/work/todo-app", true, "linux"),
    { command: "xdg-open", args: ["/work/todo-app"] },
    "directory-backed results should reveal the directory itself",
  );

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

  const reportPath = join(dir, "monthly.pdf");
  await writeFile(reportPath, "report-bytes");
  const report = runtime.repository.insertArtifact({
    id: "artifact-report",
    workspaceId: runtime.workspaceId,
    type: "document",
    name: "Monthly report.pdf",
    uri: pathToFileURL(reportPath).href,
    version: 2,
    createdBy: "analyst",
    taskId: "task-report",
    metadata: { format: "pdf", reviewed: true, mimeType: "application/pdf" },
  });
  const result = runtime.repository.insertArtifact({
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

  const outsidePath = join(outsideDir, "outside.txt");
  await writeFile(outsidePath, "outside-project");
  const outsideArtifact = runtime.repository.insertArtifact({
    id: "artifact-outside",
    workspaceId: runtime.workspaceId,
    type: "file",
    name: "Outside project",
    uri: pathToFileURL(outsidePath).href,
    createdBy: "agent",
    metadata: {},
  });
  const missingArtifact = runtime.repository.insertArtifact({
    id: "artifact-missing-file",
    workspaceId: runtime.workspaceId,
    type: "file",
    name: "Missing file",
    uri: pathToFileURL(join(dir, "missing.txt")).href,
    createdBy: "agent",
    metadata: {},
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
    uri: pathToFileURL(reportPath).href,
    createdBy: "analyst",
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const list = await request("/api/artifacts");
  assert.equal(list.status, 200);
  const artifacts = list.json.data as Array<{ id: string }>;
  assert.deepEqual(artifacts.map((artifact) => artifact.id), [
    "artifact-report",
    "artifact-result",
    "artifact-other-mission",
    "artifact-unscoped",
    "artifact-outside",
    "artifact-missing-file",
  ]);

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

  const unguardedReveal = await request(`/api/artifacts/${encodeURIComponent(report.id)}/reveal`, { method: "POST" });
  assert.equal(unguardedReveal.status, 403);
  assert.match(unguardedReveal.json.error ?? "", /explicit Chef reveal action/);
  assert.equal(revealed.length, 0, "a simple cross-origin-compatible POST must not be enough to invoke the OS opener");

  const reveal = await request(`/api/artifacts/${encodeURIComponent(report.id)}/reveal`, revealInit);
  assert.equal(reveal.status, 200);
  assert.deepEqual(revealed, [{ path: reportPath, isDirectory: false }], "reveal must use the server-resolved durable artifact path");

  const unsupportedReveal = await request(`/api/artifacts/${encodeURIComponent(result.id)}/reveal`, revealInit);
  assert.equal(unsupportedReveal.status, 409);
  assert.match(unsupportedReveal.json.error ?? "", /not backed by a local file/);

  const outsideReveal = await request(`/api/artifacts/${encodeURIComponent(outsideArtifact.id)}/reveal`, revealInit);
  assert.equal(outsideReveal.status, 403);
  assert.match(outsideReveal.json.error ?? "", /outside the project root/);

  const missingReveal = await request(`/api/artifacts/${encodeURIComponent(missingArtifact.id)}/reveal`, revealInit);
  assert.equal(missingReveal.status, 404);
  assert.match(missingReveal.json.error ?? "", /file not found/);

  const foreignReveal = await request("/api/artifacts/artifact-private-to-other-workspace/reveal", revealInit);
  assert.equal(foreignReveal.status, 404);
  assert.match(foreignReveal.json.error ?? "", /artifact not found/);

  const unknownReveal = await request("/api/artifacts/not-here/reveal", revealInit);
  assert.equal(unknownReveal.status, 404);
  assert.match(unknownReveal.json.error ?? "", /artifact not found/);
  assert.equal(revealed.length, 1, "invalid reveal requests must never invoke the OS opener");
  assert.equal(dirname(revealed[0]!.path), dir, "the accepted reveal must remain inside the active project");

  const download = await requestRaw(`/api/artifacts/${encodeURIComponent(report.id)}/download`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("content-type"), "application/pdf");
  assert.equal(download.headers.get("x-chef-artifact-id"), report.id);
  assert.equal(download.headers.get("x-chef-artifact-version"), "2");
  assert.match(download.headers.get("content-disposition") ?? "", /Monthly%20report.pdf/);
  assert.equal(await download.text(), "report-bytes");

  const unsupportedDownload = await request(`/api/artifacts/${encodeURIComponent(result.id)}/download`);
  assert.equal(unsupportedDownload.status, 409);
  assert.match(unsupportedDownload.json.error ?? "", /not backed by a downloadable file/);

  const outsideDownload = await request(`/api/artifacts/${encodeURIComponent(outsideArtifact.id)}/download`);
  assert.equal(outsideDownload.status, 403);
  assert.match(outsideDownload.json.error ?? "", /outside the project root/);

  const missingFileDownload = await request(`/api/artifacts/${encodeURIComponent(missingArtifact.id)}/download`);
  assert.equal(missingFileDownload.status, 404);
  assert.match(missingFileDownload.json.error ?? "", /file not found/);

  const foreignDownload = await request("/api/artifacts/artifact-private-to-other-workspace/download");
  assert.equal(foreignDownload.status, 404);
  assert.match(foreignDownload.json.error ?? "", /artifact not found/);

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

  console.log("artifact-http: ok — durable results can be revealed safely inside the active project without exposing arbitrary paths or commands");
} finally {
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  await runtime.close();
  await rm(dir, { recursive: true, force: true });
  await rm(outsideDir, { recursive: true, force: true });
}
