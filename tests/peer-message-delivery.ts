import { strict as assert } from "node:assert";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createChef } from "../src/main.ts";
import { createHttpServer } from "../src/server/http-server.ts";
import { defaultSidebandRoot } from "../src/harness/sideband.ts";

const dir = await mkdtemp(join(tmpdir(), "chef-peer-test-"));
const chef = createChef({ dbPath: join(dir, "chef.sqlite"), projectDir: dir });

let server: ReturnType<typeof createHttpServer>;

try {
  await chef.start();
  server = createHttpServer(chef);
  const { promise: serverReady, resolve: serverReadyResolve } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => serverReadyResolve());
  await serverReady;
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;

  // ── LLM status endpoint (no env configured in tests) ──────────────
  const llmRes = await fetch(`${base}/api/llm/status`);
  assert.equal(llmRes.status, 200, "llm status endpoint must return 200");
  const llmBody = (await llmRes.json()) as { ok: boolean; data: { configured: boolean; provider: string | null; model: string | null } };
  assert.equal(llmBody.ok, true, "llm status ok flag");
  assert.equal(llmBody.data.configured, false, "no env -> not configured in test");
  assert.equal(llmBody.data.provider, null, "no env -> provider null");
  assert.equal(llmBody.data.model, null, "no env -> model null");

  // ── Peer message: dispatch a generic task, then message its session ──
  const nodeRes = await fetch(`${base}/api/nodes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "tool.terminal", title: "peer-smoke", assignedTo: "generic" }),
  });
  assert.equal(nodeRes.status, 201, "node create 201");
  const { data: nodeData } = (await nodeRes.json()) as { data: { taskId: string; workflowNodeId: string } };
  const taskId = nodeData.taskId;

  const dispatchRes = await fetch(`${base}/api/dispatch`, { method: "POST" });
  assert.equal(dispatchRes.status, 200, "dispatch 200");

  // Wait for session to be created
  const { promise: sessionReady, resolve: sessionReadyResolve } = Promise.withResolvers<string>();
  let attempts = 0;
  while (attempts < 50) {
    const stateRes = await fetch(`${base}/api/state`);
    const state = (await stateRes.json()) as { sessions: Array<{ id: string; taskId: string; status: string; pid: number }> };
    const session = state.sessions.find((s) => s.taskId === taskId && (s.status === "running" || s.status === "spawning"));
    if (session) {
      sessionReadyResolve(session.id);
      break;
    }
    attempts++;
    await new Promise((r) => setTimeout(r, 100));
  }
  const sessionId = await sessionReady;
  assert.ok(sessionId, "session must exist for dispatched task");

  // Send peer message
  const msgRes = await fetch(`${base}/api/sessions/${sessionId}/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from: "investigator", text: "hello peer" }),
  });
  assert.equal(msgRes.status, 200, "peer message 200");

  // Verify envelope in sideband inbox
  const inboxDir = join(defaultSidebandRoot(), sessionId, "inbox");
  const { promise: inboxReady, resolve: inboxReadyResolve } = Promise.withResolvers<void>();
  let inboxAttempts = 0;
  while (inboxAttempts < 30) {
    try {
      const names = await readdir(inboxDir);
      if (names.length > 0) {
        inboxReadyResolve();
        break;
      }
    } catch {}
    inboxAttempts++;
    await new Promise((r) => setTimeout(r, 100));
  }
  await inboxReady;
  const names = await readdir(inboxDir);
  assert.ok(names.length > 0, "inbox must contain at least one envelope");
  const envelopePath = join(inboxDir, names[0]);
  const raw = await readFile(envelopePath, "utf8");
  const envelope = JSON.parse(raw);
  assert.equal(envelope.version, 1, "envelope version");
  assert.equal(envelope.kind, "message", "envelope kind");
  assert.equal(envelope.from, "peer", "envelope from");
  assert.equal(envelope.payload?.peerFrom, "investigator", "payload.peerFrom");
  assert.equal(envelope.payload?.text, "hello peer", "payload.text");
  assert.ok(envelope.id, "envelope has id");
  assert.ok(envelope.timestamp > 0, "envelope has timestamp");

  console.log("peer-message-delivery: ok — envelope matches peer message and llm status endpoint works");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await chef.close();
  await rm(dir, { recursive: true, force: true });
}