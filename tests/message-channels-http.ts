import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createMessageServer } from "../src/server/message-http.ts";
import type { ChefRuntime } from "../src/main.ts";

const workspaceId = "workspace-test";
let requestedWorkspace: string | undefined;
const insertedMessages: Array<Record<string, unknown>> = [];
const appendedEvents: Array<Record<string, unknown>> = [];
const runtime = {
  workspaceId,
  repository: {
    listMessages(id: string, channel?: string) {
      requestedWorkspace = id;
      const messages = [
        { id: "review-1", channel: "review", from: "agent-a", type: "message", payload: { text: "Review this" }, timestamp: 1 },
        { id: "build-1", channel: "build", from: "agent-b", type: "status", payload: { text: "Building" }, timestamp: 2 },
        { id: "review-2", channel: "review", from: "agent-c", type: "message", payload: { text: "LGTM" }, timestamp: 3 },
        { id: "blank", channel: "  ", from: "agent-c", type: "message", payload: {}, timestamp: 4 },
        { id: "direct", channel: undefined, from: "agent-c", type: "message", payload: {}, timestamp: 5 },
      ];
      return channel === undefined ? messages : messages.filter((message) => message.channel === channel);
    },
    transaction<T>(fn: () => T) {
      return fn();
    },
    insertMessage(input: Record<string, unknown>) {
      insertedMessages.push(input);
      return {
        id: "human-message-1",
        timestamp: 10,
        ...input,
      };
    },
    appendEvent(input: Record<string, unknown>) {
      appendedEvents.push(input);
      return { id: "event-1", seq: 1, timestamp: 10, ...input };
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

  const channelMessages = await fetch(`${baseUrl}/api/messages?channel=review`);
  assert.equal(channelMessages.status, 200);
  const channelBody = await channelMessages.json() as { ok: boolean; data: Array<{ channel?: string }> };
  assert.equal(channelBody.ok, true);
  assert.equal(channelBody.data.length, 2);
  assert.ok(channelBody.data.every((message) => message.channel === "review"));

  const create = await fetch(`${baseUrl}/api/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel: " review ", text: "  Please re-check the diff.  " }),
  });
  assert.equal(create.status, 201);
  const createBody = await create.json() as { ok: boolean; data: { id: string; from: string; channel: string; payload: { text: string } } };
  assert.equal(createBody.ok, true);
  assert.equal(createBody.data.id, "human-message-1");
  assert.equal(createBody.data.from, "human");
  assert.equal(createBody.data.channel, "review");
  assert.deepEqual(createBody.data.payload, { text: "Please re-check the diff." });
  assert.deepEqual(insertedMessages, [{
    workspaceId,
    from: "human",
    channel: "review",
    type: "message",
    payload: { text: "Please re-check the diff." },
  }]);
  assert.deepEqual(appendedEvents, [{
    workspaceId,
    source: { type: "human", id: "human" },
    type: "message.sent",
    payload: { messageId: "human-message-1", channel: "review", type: "message" },
  }]);

  const emptyText = await fetch(`${baseUrl}/api/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel: "review", text: "   " }),
  });
  assert.equal(emptyText.status, 400);

  const emptyChannel = await fetch(`${baseUrl}/api/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel: "   ", text: "hello" }),
  });
  assert.equal(emptyChannel.status, 400);

  const malformed = await fetch(`${baseUrl}/api/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  assert.equal(malformed.status, 400);

  const fallback = await fetch(`${baseUrl}/not-a-message-route`);
  assert.equal(fallback.status, 404);
  console.log("message-channels-http: PASS");
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
