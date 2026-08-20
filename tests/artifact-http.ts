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
  const report = runtime.repository.insertArtifact({
    id: "artifact-report",
    workspaceId: runtime.workspaceId,
    type: "document",
    name: "Monthly report",
    uri: "file:///reports/monthly.pdf",
    version: 2,
    createdBy: "analyst",
    metadata: { format: "pdf", reviewed: true },
  });
  runtime.repository.insertArtifact({
    id: "artifact-result",
    workspaceId: runtime.workspaceId,
    type: "result",
    name: "Verification result",
    uri: "sideband://verification/result.json",
    createdBy: "verifier",
    metadata: { passed: true },
  });
  const otherWorkspace = runtime.repository.createWorkspace({ name: "Other workspace" });
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
  assert.deepEqual(artifacts.map((artifact) => artifact.id), ["artifact-report", "artifact-result"]);

  const documents = await request("/api/artifacts?type=document&createdBy=analyst");
  assert.equal(documents.status, 200);
  assert.deepEqual((documents.json.data as Array<{ id: string }>).map((artifact) => artifact.id), ["artifact-report"]);

  const detail = await request(`/api/artifacts/${encodeURIComponent(report.id)}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.json.data, report);

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
