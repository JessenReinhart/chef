import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentMessage } from "../src/core/types.ts";
import { createMessageServer } from "../src/server/message-http.ts";

const messages: AgentMessage[] = [
  { id: "m1", workspaceId: "w1", from: "researcher", to: "coder", channel: "frontend", type: "finding", payload: { text: "Found the render bug" }, timestamp: 1 },
  { id: "m2", workspaceId: "w1", from: "coder", to: "researcher", channel: "frontend", type: "response", payload: { text: "Fixing it" }, timestamp: 2 },
  { id: "m3", workspaceId: "w1", from: "orchestrator", to: "user", channel: "orchestrator", type: "status", payload: { text: "Working" }, timestamp: 3 },
];
const runtime = { workspaceId: "w1", repository: { listMessages(workspaceId: string, channel?: string) { assert.equal(workspaceId, "w1"); return channel ? messages.filter((message) => message.channel === channel) : messages; } } } as never;
const base = createServer((_req, res) => { res.writeHead(418); res.end("base"); });
const server = createMessageServer(runtime, base);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address() as AddressInfo;
const root = `http://127.0.0.1:${address.port}`;
try {
  const all = await fetch(`${root}/api/messages`); assert.equal(all.status, 200); assert.deepEqual(((await all.json()) as { data: AgentMessage[] }).data.map((m) => m.id), ["m1", "m2", "m3"]);
  const channel = await fetch(`${root}/api/messages?channel=frontend`); assert.deepEqual(((await channel.json()) as { data: AgentMessage[] }).data.map((m) => m.id), ["m1", "m2"]);
  const inbox = await fetch(`${root}/api/messages?agentId=researcher&direction=in`); assert.deepEqual(((await inbox.json()) as { data: AgentMessage[] }).data.map((m) => m.id), ["m2"]);
  const outbox = await fetch(`${root}/api/messages?agentId=researcher&direction=out`); assert.deepEqual(((await outbox.json()) as { data: AgentMessage[] }).data.map((m) => m.id), ["m1"]);
  assert.equal((await fetch(`${root}/api/messages?agentId=researcher&direction=sideways`)).status, 400);
  assert.equal((await fetch(`${root}/api/messages?direction=in`)).status, 400);
  assert.equal((await fetch(`${root}/unrelated`)).status, 418, "wrapper preserves base handler");
  console.log("message-http: ok — workspace messages support channel and inbox/outbox projections");
} finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
