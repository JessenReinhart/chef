import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createChef } from "../src/main.ts";
import { createHttpServer } from "../src/server/http-server.ts";
import { createContextScopeServer } from "../src/server/context-scope-http.ts";

const dir = await mkdtemp(join(tmpdir(), "chef-http-test-"));
const chef = createChef({ dbPath: join(dir, "chef.sqlite"), projectDir: dir });

try {
  await chef.start();
  const baseServer = createHttpServer(chef);
  const server = createContextScopeServer(chef, baseServer);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;

  const stateRes = await fetch(`${base}/api/state`);
  assert.equal(stateRes.status, 200, "state endpoint must return 200");
  const snapshot = (await stateRes.json()) as { workspaceId: string; tasks: unknown[] };
  assert.equal(typeof snapshot.workspaceId, "string", "state must include workspaceId");

  const scopesBefore = await fetch(`${base}/api/context-scopes`);
  assert.equal(scopesBefore.status, 200, "context scopes endpoint must return 200");
  assert.deepEqual((await scopesBefore.json()).data, [], "new workspace should have no scopes");

  const createScope = await fetch(`${base}/api/context-scopes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Authentication",
      bounds: { x: 0, y: 0, width: 500, height: 300 },
      contextRefs: [{ type: "artifact", id: "requirements" }],
    }),
  });
  assert.equal(createScope.status, 201, "creating a context scope must return 201");
  const createdScope = (await createScope.json()).data as { id: string; memberNodeIds: string[] };
  assert.ok(createdScope.id, "created scope must have an id");

  const listedScopes = await fetch(`${base}/api/context-scopes`);
  assert.equal((await listedScopes.json()).data.length, 1, "created scope must be listed");

  const createNode = await fetch(`${base}/api/nodes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "tool.file",
      title: "Disposable node",
      kind: "tool",
      position: { x: 120, y: 80 },
    }),
  });
  assert.equal(createNode.status, 201, "creating a disposable node must return 201");
  const { taskId: disposableTaskId } = (await createNode.json()).data as { taskId: string };

  const addScopeMember = await fetch(`${base}/api/context-scopes/${createdScope.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ memberNodeIds: [disposableTaskId] }),
  });
  assert.equal(addScopeMember.status, 200, "context scope must accept the disposable node as a member");

  const deleteNode = await fetch(`${base}/api/nodes/${disposableTaskId}`, { method: "DELETE" });
  assert.equal(deleteNode.status, 200, "deleting a canvas node must return 200");

  const afterNodeDelete = (await (await fetch(`${base}/api/state`)).json()) as {
    tasks: Array<{ id: string; status: string }>;
    canvasNodes: Array<{ id: string; taskId?: string }>;
  };
  assert.equal(
    afterNodeDelete.canvasNodes.some((node) => node.id === disposableTaskId || node.taskId === disposableTaskId),
    false,
    "deleted node must not remain in the durable canvas",
  );
  assert.equal(
    afterNodeDelete.tasks.find((task) => task.id === disposableTaskId)?.status,
    "cancelled",
    "deleting a pending node must retain its task as cancelled history",
  );

  const scopeAfterNodeDelete = (await (await fetch(`${base}/api/context-scopes`)).json()).data as Array<{ id: string; memberNodeIds: string[] }>;
  assert.equal(
    scopeAfterNodeDelete.find((scope) => scope.id === createdScope.id)?.memberNodeIds.includes(disposableTaskId),
    false,
    "deleting a node must remove stale Shared Context membership",
  );

  const deleteScope = await fetch(`${base}/api/context-scopes/${createdScope.id}`, { method: "DELETE" });
  assert.equal(deleteScope.status, 200, "deleting a context scope must return 200");

  const result = await chef.sendUserMessage("run the http server plan");
  assert.equal(result.ok, true, `orchestration failed: ${result.report}`);

  const refreshed = (await (await fetch(`${base}/api/state`)).json()) as {
    tasks: Array<{ status: string }>;
    events: unknown[];
  };
  assert.ok(refreshed.tasks.length >= 2, "plan tasks must be visible");
  assert.ok(refreshed.events.length > 0, "persisted events must be visible");

  const missingRes = await fetch(`${base}/api/nope`);
  assert.equal(missingRes.status, 404, "unknown route must 404");

  const badSend = await fetch(`${base}/api/sessions/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(badSend.status, 400, "invalid send body must 400");

  const approval = (snapshot as { approvals?: unknown[] }).approvals?.[0];
  if (approval) {
    const approveRes = await fetch(`${base}/api/approvals/${(approval as { id: string }).id}/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approver: "tester" }),
    });
    assert.equal(approveRes.status, 200, "approval accept must return 200");
  }
  const missingApproval = await fetch(`${base}/api/approvals/nope/reject`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(missingApproval.status, 500, "unknown approval must 500");

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await chef.close();
  console.log("http-server: ok — state, SSE projection, context scopes, and durable node deletion live");
} finally {
  await rm(dir, { recursive: true, force: true });
}
