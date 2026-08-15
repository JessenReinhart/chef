/**
 * API harness-listing regression for the blueprint canvas (spec §4):
 *  1. GET /api/harnesses returns every known candidate (pi, omp, freebuff,
 *     claude-code, generic) with id/name/type/available and ok=true.
 *  2. POST /api/nodes accepts assignedTo and persists it on the created task.
 */
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createChef } from "../src/main.ts";
import { createHttpServer } from "../src/server/http-server.ts";

const dir = await mkdtemp(join(tmpdir(), "chef-api-harnesses-"));
const chef = createChef({ dbPath: join(dir, "chef.sqlite"), projectDir: dir });

try {
  await chef.start();
  const server = createHttpServer(chef);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;

  // GET /api/harnesses — list ALL known candidates with availability.
  const res = await fetch(`${base}/api/harnesses`);
  assert.equal(res.status, 200, "harnesses endpoint must return 200");
  const body = (await res.json()) as { ok: boolean; data: Array<{ id: string; name: string; available: boolean; type: string }> };
  assert.equal(body.ok, true, "response must be ok");
  assert.ok(Array.isArray(body.data), "data must be an array");

  const byId = new Map(body.data.map((h) => [h.id, h]));
  const expected = ["pi", "omp", "freebuff", "claude-code", "generic"];
  for (const id of expected) {
    assert.ok(byId.has(id), `harness ${id} must be listed`);
    const entry = byId.get(id)!;
    assert.equal(typeof entry.name, "string", `${id} name must be a string`);
    assert.equal(typeof entry.type, "string", `${id} type must be a string`);
    assert.equal(typeof entry.available, "boolean", `${id} available must be a boolean`);
  }
  // generic fallback is always available (node-pty)
  assert.equal(byId.get("generic")!.available, true, "generic must always be available");
  // At least one specialized harness is available in CI (omp or freebuff)
  assert.ok(
    byId.get("omp")!.available || byId.get("freebuff")!.available,
    "at least one specialized harness must be detected as available",
  );
  console.log("GET /api/harnesses ok:", body.data.map((h) => `${h.id}=${h.available}`).join(", "));

  // POST /api/nodes with assignedTo — the blueprint creation path.
  const nodeRes = await fetch(`${base}/api/nodes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "tool.terminal", title: "test-node", assignedTo: "investigator" }),
  });
  assert.equal(nodeRes.status, 201, "node creation must return 201");
  const nodeBody = (await nodeRes.json()) as { ok: boolean; data: { taskId: string } };
  assert.equal(nodeBody.ok, true, "node response must be ok");
  assert.ok(nodeBody.data.taskId, "node response must include taskId");

  const persisted = chef.repository.getTask(nodeBody.data.taskId);
  assert.ok(persisted, "created task must be persisted");
  assert.equal(persisted!.assignedTo, "investigator", "assignedTo must be persisted on the task");
  console.log("POST /api/nodes assignedTo persisted:", persisted!.assignedTo);

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await chef.close();
  console.log("api-harnesses: ok");
} finally {
  await rm(dir, { recursive: true, force: true });
}
