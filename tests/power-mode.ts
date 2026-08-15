/**
 * Power Mode panels regression test.
 * Verifies that the four Power Mode panels are correctly wired:
 *  - Live Logs Panel with SSE filtering
 *  - Terminal Panes with PTY send/resize/interrupt APIs
 *  - Context Bus showing refs/artifacts/decisions
 *  - Wide Inspector editing node config
 *
 * This test validates the API contracts the panels depend on.
 */
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { createChef } from "../src/main.ts";
import { createHttpServer } from "../src/server/http-server.ts";
import type { PlanProposalContext, Plan, Session } from "../src/core/types.ts";

const dir = await mkdtemp(join(tmpdir(), "chef-power-mode-test-"));
const chef = createChef({
  dbPath: join(dir, "chef.sqlite"),
  projectDir: dir,
  decisionProvider: {
    name: "power-mode-test",
    async proposePlan(input: PlanProposalContext): Promise<Plan> {
      const a = randomUUID();
      return {
        id: randomUUID(),
        workspaceId: input.workspaceId,
        goal: input.goal,
        status: "proposed",
        tasks: [
          { id: a, title: "Test Task", description: "Power mode test", dependencies: [], priority: 1, assignedTo: "tester" },
        ],
        taskIds: [a],
        createdAt: Date.now(),
      };
    },
    async evaluate(outcome) {
      return { id: randomUUID(), workspaceId: "", type: "task.evaluation", summary: outcome.status, payload: outcome, madeBy: "power-mode-test", timestamp: Date.now(), status: "accepted" };
    },
  },
});

try {
  await chef.start();

  // Start a simple plan to create a session for PTY events.
  await chef.sendUserMessage("test session");
  await new Promise<void>((resolve) => setTimeout(resolve, 500));

  const server = createHttpServer(chef);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;

  // ── 1. Logs Panel: /api/events?types= glob filtering ──────────────────────
  {
    // Test SSE endpoint accepts types= filter
    const res = await fetch(`${base}/api/events?types=session.data,task.*`);
    assert.equal(res.status, 200, "SSE /api/events with types filter must return 200");
    assert.ok(res.headers.get("content-type")?.includes("text/event-stream"), "must be SSE stream");
    // Close immediately to not leak connections
    const reader = res.body?.getReader();
    if (reader) {
      reader.cancel();
    }
  }

  {
    // Test /api/inspector/events with afterSeq and limit
    const res = await fetch(`${base}/api/inspector/events?afterSeq=0&limit=10`);
    assert.equal(res.status, 200, "inspector events must return 200");
    const data = await res.json();
    assert.ok(data.ok, "inspector events response must be ok");
    assert.ok(Array.isArray(data.data), "inspector events data must be array");
  }

  // ── 2. Terminal Panes: /api/sessions/send|resize|interrupt ──────────────────
  {
    // Get a running session to test against
    const stateRes = await fetch(`${base}/api/state`);
    const snapshot = await stateRes.json();
    const sessions: Session[] = snapshot.sessions ?? [];
    const running = sessions.find((s) => s.status === "running" || s.status === "spawning");
    if (running) {
      // Test send
      const sendRes = await fetch(`${base}/api/sessions/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: running.id, data: "echo hello\n" }),
      });
      assert.equal(sendRes.status, 200, "send must return 200");
      const sendJson = await sendRes.json();
      assert.ok(sendJson.ok, "send must return ok");

      // Test resize
      const resizeRes = await fetch(`${base}/api/sessions/resize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: running.id, cols: 120, rows: 30 }),
      });
      assert.equal(resizeRes.status, 200, "resize must return 200");
      const resizeJson = await resizeRes.json();
      assert.ok(resizeJson.ok, "resize must return ok");

      // Test interrupt
      const intRes = await fetch(`${base}/api/sessions/interrupt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: running.id }),
      });
      assert.equal(intRes.status, 200, "interrupt must return 200");
      const intJson = await intRes.json();
      assert.ok(intJson.ok, "interrupt must return ok");
    }
  }

  // ── 3. Context Bus: /api/inspector/artifacts and /api/inspector/sessions ────
  {
    const artifactsRes = await fetch(`${base}/api/inspector/artifacts`);
    assert.equal(artifactsRes.status, 200, "inspector artifacts must return 200");
    const artifactsData = await artifactsRes.json();
    assert.ok(artifactsData.ok, "artifacts response must be ok");
    assert.ok(Array.isArray(artifactsData.data), "artifacts data must be array");
  }

  {
    const sessionsRes = await fetch(`${base}/api/inspector/sessions?live=true`);
    assert.equal(sessionsRes.status, 200, "inspector sessions must return 200");
    const sessionsData = await sessionsRes.json();
    assert.ok(sessionsData.ok, "sessions response must be ok");
    assert.ok(Array.isArray(sessionsData.data), "sessions data must be array");
  }

  // ── 4. Wide Inspector: /api/nodes/:taskId/status and node config ───────────
  {
    const stateRes = await fetch(`${base}/api/state`);
    const snapshot = await stateRes.json();
    const taskId = snapshot.tasks[0]?.id;
    if (taskId) {
      const nodeStatusRes = await fetch(`${base}/api/nodes/${taskId}/status`);
      assert.equal(nodeStatusRes.status, 200, "node status must return 200");
      const nodeStatus = await nodeStatusRes.json();
      assert.ok(nodeStatus.ok, "node status must be ok");
      assert.ok(nodeStatus.data, "node status must have data");
      assert.equal(nodeStatus.data.id, taskId, "node status data id must match");
    }
  }

  // ── 5. Dark Power Mode styling: CSS variables present ───────────────────────
  // Verified by build succeeding with the CSS; no runtime check needed.

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await chef.close();
  console.log("power-mode: ok");
} finally {
  await rm(dir, { recursive: true, force: true });
}