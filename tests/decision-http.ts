import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createChef } from "../src/main.ts";
import { createHttpServer } from "../src/server/http-server.ts";
import { createDecisionServer } from "../src/server/decision-http.ts";

const dir = await mkdtemp(join(tmpdir(), "chef-decision-http-"));
const runtime = createChef({ dbPath: join(dir, "chef.sqlite"), projectDir: dir });
const server = createDecisionServer(runtime, createHttpServer(runtime));

const request = async (path: string) => {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
  return { status: response.status, json: await response.json() as { ok?: boolean; data?: unknown; error?: string } };
};

try {
  const architecture = runtime.repository.insertDecision({
    id: "decision-architecture",
    workspaceId: runtime.workspaceId,
    type: "architecture",
    summary: "Keep runtime state authoritative",
    payload: { rationale: "Avoid client-side split brain" },
    madeBy: "orchestrator",
    timestamp: Date.parse("2026-08-21T00:00:00.000Z"),
    status: "accepted",
  });
  runtime.repository.insertDecision({
    id: "decision-rejected",
    workspaceId: runtime.workspaceId,
    type: "approach",
    summary: "Do not duplicate persistence in the UI",
    payload: { rejectedApproach: "local-only state" },
    madeBy: "reviewer",
    timestamp: Date.parse("2026-08-21T00:01:00.000Z"),
    status: "rejected",
  });
  const otherWorkspace = runtime.repository.createWorkspace({ name: "Other workspace" });
  runtime.repository.insertDecision({
    id: "decision-private-to-other-workspace",
    workspaceId: otherWorkspace.id,
    type: "architecture",
    summary: "Other workspace decision",
    payload: {},
    madeBy: "orchestrator",
    timestamp: Date.parse("2026-08-21T00:02:00.000Z"),
    status: "accepted",
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const list = await request("/api/decisions");
  assert.equal(list.status, 200);
  assert.deepEqual((list.json.data as Array<{ id: string }>).map((decision) => decision.id), ["decision-architecture", "decision-rejected"]);

  const filtered = await request("/api/decisions?status=accepted&type=architecture&madeBy=orchestrator");
  assert.equal(filtered.status, 200);
  assert.deepEqual((filtered.json.data as Array<{ id: string }>).map((decision) => decision.id), ["decision-architecture"]);

  const detail = await request(`/api/decisions/${encodeURIComponent(architecture.id)}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.json.data, JSON.parse(JSON.stringify(architecture)));

  const missing = await request("/api/decisions/not-here");
  assert.equal(missing.status, 404);
  assert.match(missing.json.error ?? "", /decision not found/);
  assert.equal((await request("/api/decisions/decision-private-to-other-workspace")).status, 404);

  const invalidStatus = await request("/api/decisions?status=archived");
  assert.equal(invalidStatus.status, 400);
  assert.match(invalidStatus.json.error ?? "", /status must be one of/);

  const state = await request("/api/state");
  assert.equal(state.status, 200);
  assert.ok(Array.isArray((state.json as Record<string, unknown>).decisions));
  console.log("decision-http: ok");
} finally {
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  await runtime.close();
  await rm(dir, { recursive: true, force: true });
}
