import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createMessageServer } from "../src/server/message-http.ts";
import type { ChefRuntime } from "../src/main.ts";

const workspaceId = "workspace-test";
let requestedWorkspace: string | undefined;
const runtime = {
  workspaceId,
  repository: {
    listMessages(id: string) {
      requestedWorkspace = id;
      return [
        { channel: "review" },
        { channel: "build" },
        { channel: "review" },
        { channel: "  " },
        { channel: undefined },
      ];
    },
  },
} as unknown as ChefRuntime;

const baseServer = createServer((_req, res) => {
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});
const server = createMessageServer(runtime, baseServer);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;

try {
  const response = await fetch(`${baseUrl}/api/messages/channels`);
  assert.equal(response.status, 200);
  assert.equal(requestedWorkspace, workspaceId);
  const body = await response.json() as {
    ok: boolean;
    data: Array<{ channel: string; messageCount: number }>;
  };
  assert.equal(body.ok, true);
  assert.deepEqual(body.data, [
    { channel: "build", messageCount: 1 },
    { channel: "review", messageCount: 2 },
  ]);

  const fallback = await fetch(`${baseUrl}/not-a-message-route`);
  assert.equal(fallback.status, 404);
  console.log("message-channels-http: PASS");
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
