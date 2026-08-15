import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createChef } from "../src/main.ts";
import { createHttpServer } from "../src/server/http-server.ts";

const dir = await mkdtemp(join(tmpdir(), "chef-http-test-"));
const chef = createChef({ dbPath: join(dir, "chef.sqlite"), projectDir: dir });

try {
  await chef.start();
  const server = createHttpServer(chef);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;

  const stateRes = await fetch(`${base}/api/state`);
  assert.equal(stateRes.status, 200, "state endpoint must return 200");
  const snapshot = (await stateRes.json()) as { workspaceId: string; tasks: unknown[] };
  assert.equal(typeof snapshot.workspaceId, "string", "state must include workspaceId");

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
  console.log("http-server: ok — state and SSE projection endpoints live");
} finally {
  await rm(dir, { recursive: true, force: true });
}
