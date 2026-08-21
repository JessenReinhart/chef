import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Repository } from "../src/persistence/database.ts";
import { createArtifactLineageServer } from "../src/server/artifact-lineage-http.ts";
import type { ChefRuntime } from "../src/main.ts";

const dir = await mkdtemp(join(tmpdir(), "chef-artifact-lineage-"));
const repository = new Repository(join(dir, "chef.sqlite"));
const workspace = repository.createWorkspace({ name: "Lineage workspace" });
const runtime = { workspaceId: workspace.id, repository } as ChefRuntime;
const baseServer = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ base: true }));
});
const server = createArtifactLineageServer(runtime, baseServer);

const request = async (path: string) => {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
  return { status: response.status, json: await response.json() as Record<string, unknown> };
};

try {
  repository.insertTask({ id: "source-task", workspaceId: workspace.id, title: "Collect source", description: "", status: "completed" });
  repository.insertTask({
    id: "analysis-task", workspaceId: workspace.id, title: "Analyze source", description: "", status: "completed",
    contextRefs: [{ type: "artifact", id: "source-artifact" }, { type: "artifact", id: "private-artifact" }],
  });
  repository.insertTask({
    id: "consumer-task", workspaceId: workspace.id, title: "Use analysis", description: "", status: "running",
    contextRefs: [{ type: "artifact", id: "analysis-artifact" }, { type: "artifact", id: "missing-artifact" }],
  });
  repository.insertTask({
    id: "unrelated-task", workspaceId: workspace.id, title: "Unrelated", description: "", status: "pending",
    contextRefs: [{ type: "artifact", id: "source-artifact" }],
  });

  repository.insertArtifact({ id: "source-artifact", workspaceId: workspace.id, type: "research", name: "Source", uri: "file:///source.md", createdBy: "researcher", taskId: "source-task" });
  repository.insertArtifact({ id: "analysis-artifact", workspaceId: workspace.id, type: "result", name: "Analysis", uri: "file:///analysis.json", createdBy: "analyst", taskId: "analysis-task" });
  repository.insertArtifact({ id: "downstream-artifact", workspaceId: workspace.id, type: "document", name: "Final", uri: "file:///final.md", createdBy: "writer", taskId: "consumer-task" });
  repository.insertArtifact({ id: "unrelated-artifact", workspaceId: workspace.id, type: "result", name: "Other", uri: "file:///other.json", createdBy: "other", taskId: "unrelated-task" });

  const otherWorkspace = repository.createWorkspace({ name: "Other" });
  repository.insertArtifact({ id: "private-artifact", workspaceId: otherWorkspace.id, type: "result", name: "Private", uri: "file:///private", createdBy: "other" });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const response = await request("/api/artifacts/analysis-artifact/lineage");
  assert.equal(response.status, 200);
  const data = response.json.data as {
    artifact: { id: string };
    producerTask: { id: string } | null;
    upstreamArtifacts: Array<{ id: string }>;
    consumerTasks: Array<{ id: string }>;
    downstreamArtifacts: Array<{ id: string }>;
  };
  assert.equal(data.artifact.id, "analysis-artifact");
  assert.equal(data.producerTask?.id, "analysis-task");
  assert.deepEqual(data.upstreamArtifacts.map((item) => item.id), ["source-artifact"]);
  assert.deepEqual(data.consumerTasks.map((item) => item.id), ["consumer-task"]);
  assert.deepEqual(data.downstreamArtifacts.map((item) => item.id), ["downstream-artifact"]);

  assert.equal((await request("/api/artifacts/private-artifact/lineage")).status, 404);
  assert.equal((await request("/api/artifacts/missing/lineage")).status, 404);
  const fallthrough = await request("/api/anything-else");
  assert.equal(fallthrough.status, 200);
  assert.equal(fallthrough.json.base, true);
  console.log("artifact-lineage-http: ok");
} finally {
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  baseServer.close();
  repository.close();
  await rm(dir, { recursive: true, force: true });
}
