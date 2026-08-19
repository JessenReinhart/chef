import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createChef } from "../src/main.ts";
import { Repository } from "../src/persistence/database.ts";
import { createContextScopeServer } from "../src/server/context-scope-http.ts";
import { createHttpServer } from "../src/server/http-server.ts";

const dir = await mkdtemp(join(tmpdir(), "chef-v02-persistence-"));
const dbPath = join(dir, "chef.sqlite");
const runtime = createChef({ dbPath, projectDir: dir });
const server = createContextScopeServer(runtime, createHttpServer(runtime));

const request = async (path: string, method: string, body?: unknown) => {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() as Record<string, unknown> };
};

try {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const alphaResponse = await request("/api/nodes", "POST", { type: "agent", title: "Alpha", kind: "agent" });
  const betaResponse = await request("/api/nodes", "POST", { type: "agent", title: "Beta", kind: "agent" });
  const alpha = (alphaResponse.json.data as { taskId: string }).taskId;
  const beta = (betaResponse.json.data as { taskId: string }).taskId;

  runtime.repository.upsertCanvasNode({
    id: alpha,
    workspaceId: runtime.workspaceId,
    taskId: alpha,
    label: "Configured Alpha",
    kind: "terminal",
    harnessId: "terminal-harness",
    liveStatus: "running",
    config: { command: "npm test" },
    position: { x: 10, y: 20 },
  });
  runtime.repository.upsertCanvasNode({
    id: alpha,
    workspaceId: runtime.workspaceId,
    label: "Moved Alpha",
    position: { x: 80, y: 90 },
  });
  const preserved = runtime.listCanvas(runtime.workspaceId).nodes.find((node) => node.id === alpha)!;
  assert.equal(preserved.taskId, alpha);
  assert.equal(preserved.kind, "terminal");
  assert.equal(preserved.harnessId, "terminal-harness");
  assert.equal(preserved.liveStatus, "running");
  assert.deepEqual(preserved.config, { command: "npm test" });
  assert.deepEqual(preserved.position, { x: 80, y: 90 });

  runtime.repository.updateTaskContextRefs(alpha, [{ type: "decision", id: "base" }]);
  const zone = runtime.repository.upsertContextZone({
    workspaceId: runtime.workspaceId,
    name: "Shared research",
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    memberNodeIds: [alpha],
    contextRefs: [{ type: "artifact", id: "shared" }],
  });
  runtime.repository.syncContextZoneRefs(runtime.workspaceId, [
    { zoneId: zone.id, taskId: alpha, contextRefs: zone.contextRefs },
  ]);
  assert.deepEqual(runtime.repository.getTask(alpha)?.contextRefs, [
    { type: "decision", id: "base" },
    { type: "artifact", id: "shared" },
  ]);
  runtime.repository.deleteContextZone(zone.id);
  assert.deepEqual(runtime.repository.getTask(alpha)?.contextRefs, [{ type: "decision", id: "base" }]);

  const httpZoneResponse = await request("/api/context-scopes", "POST", {
    name: "HTTP shared research",
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    memberNodeIds: [alpha],
    contextRefs: [{ type: "artifact", id: "http-shared" }],
  });
  assert.equal(httpZoneResponse.status, 201);
  const httpZoneId = (httpZoneResponse.json.data as { id: string }).id;
  assert.deepEqual(runtime.repository.getTask(alpha)?.contextRefs, [
    { type: "decision", id: "base" },
    { type: "artifact", id: "http-shared" },
  ]);
  assert.equal((await request(`/api/context-scopes/${httpZoneId}`, "PATCH", { memberNodeIds: [] })).status, 200);
  assert.deepEqual(runtime.repository.getTask(alpha)?.contextRefs, [{ type: "decision", id: "base" }]);
  assert.equal((await request(`/api/context-scopes/${httpZoneId}`, "DELETE")).status, 200);

  assert.throws(() => runtime.repository.upsertContextZone({
    workspaceId: runtime.workspaceId,
    name: "Invalid membership",
    bounds: { x: 0, y: 0, width: 1, height: 1 },
    memberNodeIds: ["not-a-canvas-node"],
  }), /not a canvas node/);
  const invalidScope = await request("/api/context-scopes", "POST", {
    name: "Invalid HTTP membership",
    bounds: { x: 0, y: 0, width: 1, height: 1 },
    memberNodeIds: ["not-a-canvas-node"],
  });
  assert.equal(invalidScope.status, 400);

  await request("/api/edges", "POST", { source: alpha, target: beta, type: "communication" });
  await request("/api/edges", "POST", { source: alpha, target: beta, type: "dependency" });
  assert.deepEqual(runtime.repository.getTask(beta)?.dependencies, [alpha]);
  assert.equal((await request(`/api/edges/${encodeURIComponent(`${alpha}->${beta}:communication`)}`, "DELETE")).status, 200);
  assert.deepEqual(runtime.repository.getTask(beta)?.dependencies, [alpha], "deleting communication must retain dependency ordering");
  assert.deepEqual(runtime.listCanvas(runtime.workspaceId).edges.map((edge) => edge.type), ["dependency"]);
  assert.equal((await request(`/api/edges/${encodeURIComponent(`${alpha}->${beta}:dependency`)}`, "DELETE")).status, 200);
  assert.deepEqual(runtime.repository.getTask(beta)?.dependencies, []);
  assert.deepEqual(runtime.listCanvas(runtime.workspaceId).edges, []);

  await runtime.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

  // Simulate the residue from an interrupted pre-transaction migration. The
  // next open merges its rows into the typed table and removes the temp table.
  const raw = new Repository(dbPath);
  raw.db.exec(`
    CREATE TABLE canvas_edges_legacy_v01 (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, source TEXT NOT NULL, target TEXT NOT NULL,
      source_handle TEXT, target_handle TEXT, updated_at INTEGER NOT NULL, UNIQUE(source, target)
    );
    INSERT INTO canvas_edges_legacy_v01 VALUES ('recovered-edge', '${runtime.workspaceId}', '${alpha}', '${beta}', NULL, NULL, 1);
  `);
  raw.close();
  const recovered = new Repository(dbPath);
  assert.equal(recovered.listCanvasEdges(runtime.workspaceId).some((edge) => edge.id === "recovered-edge" && edge.type === "context"), true);
  assert.equal(recovered.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'canvas_edges_legacy_v01'`).get(), undefined);
  recovered.close();

  console.log("product-runtime-v02-persistence: ok");
} finally {
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  try { await runtime.close(); } catch { /* already closed */ }
  await rm(dir, { recursive: true, force: true });
}
