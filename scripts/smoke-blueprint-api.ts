import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createChef } from "../src/main.ts";
import { createHttpServer } from "../src/server/http-server.ts";
import { GenericTerminalHarness } from "../src/harness/generic.ts";
import type { HarnessEvent } from "../src/core/types.ts";

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "chef-smoke-blueprint-"));
  const dbPath = join(dir, "chef.db");
  const projectDir = dir;

  try {
    const chef = createChef({ dbPath, projectDir });
    await chef.start();
    const server = createHttpServer(chef);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    // 1. GET /api/harnesses — every known candidate with availability.
    const harnessRes = await fetch(`${base}/api/harnesses`);
    if (harnessRes.status !== 200) throw new Error(`GET /api/harnesses -> ${harnessRes.status}`);
    const harnessBody = (await harnessRes.json()) as { ok: boolean; data: Array<{ id: string; name: string; available: boolean; type: string }> };
    if (!harnessBody.ok || !Array.isArray(harnessBody.data)) throw new Error("GET /api/harnesses malformed body");
    const ids = harnessBody.data.map((h) => h.id);
    for (const expected of ["pi", "omp", "freebuff", "claude-code", "generic"]) {
      if (!ids.includes(expected)) throw new Error(`GET /api/harnesses missing candidate ${expected}`);
    }
    for (const h of harnessBody.data) {
      if (typeof h.available !== "boolean" || typeof h.name !== "string" || typeof h.type !== "string") {
        throw new Error(`GET /api/harnesses entry malformed: ${JSON.stringify(h)}`);
      }
    }
    console.log("GET /api/harnesses ok:", harnessBody.data.map((h) => `${h.id}=${h.available}`).join(", "));

    // Write a self-contained investigator script that writes an artifact to the
    // sideband outbox (mirrors ScriptedDecisionProvider's investigator.js).
    const scriptsDir = join(tmpdir(), "chef-sideband", "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    const investigatorScript = join(scriptsDir, "investigator-smoke.js");
    writeFileSync(investigatorScript, `
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const sessionId = process.env.CHEF_SESSION_ID;
if (!sessionId) { console.error("no session"); process.exit(1); }
const outbox = path.join(os.tmpdir(), "chef-sideband", sessionId, "outbox");
fs.mkdirSync(outbox, { recursive: true });
fs.writeFileSync(
  path.join(outbox, crypto.randomUUID() + ".json"),
  JSON.stringify({ type: "file", name: "investigation.txt", content: "done", encoding: "utf8", mimeType: "text/plain", metadata: { source: "investigator" } }),
);
console.log("investigation complete");
process.exit(0);
`, "utf8");

    // Register a generic harness for the "investigator" agent so the
    // scheduler can spawn it (blueprint canvas dispatch path).
    const harness = new GenericTerminalHarness({
      agentId: "investigator",
      workspaceId: chef.workspaceId,
      command: "node",
      args: [investigatorScript],
      cwd: projectDir,
    });
    chef.registerHarness("investigator", harness);

    // 2. POST /api/nodes with assignedTo + autoDispatch — the blueprint path.
    const nodeRes = await fetch(`${base}/api/nodes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "investigate",
        title: "Investigate via blueprint",
        assignedTo: "investigator",
        autoDispatch: true,
      }),
    });
    if (nodeRes.status !== 201) throw new Error(`POST /api/nodes -> ${nodeRes.status}`);
    const nodeBody = (await nodeRes.json()) as { ok: boolean; data: { taskId: string } };
    if (!nodeBody.ok || !nodeBody.data.taskId) throw new Error("POST /api/nodes malformed body");
    const taskId = nodeBody.data.taskId;
    console.log("POST /api/nodes ok, task:", taskId);

    // 3. Wait for the spawned session to be fully live (status "running"
    //    means the harness spawn resolved and the session is tracked), then
    //    consume its events through the runtime adapter so the scheduler
    //    drives the task to a terminal state.
    let sessionId: string | null = null;
    for (let i = 0; i < 40 && !sessionId; i++) {
      const snap = chef.repository.getWorkspaceSnapshot(chef.workspaceId);
      const sess = snap.sessions.find((s) => s.taskId === taskId && s.status === "running");
      if (sess) {
        sessionId = sess.id;
        console.log("Found live session:", sessionId);
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!sessionId) throw new Error("session not found for dispatched task");

    // Consume harness events and forward them to the scheduler so the task
    // reaches a terminal state (mirrors the orchestrator's consume loop).
    console.log("Attaching to harness event stream...");
    const stream = harness.events(sessionId);
    let eventCount = 0;
    for await (const event of stream) {
      eventCount++;
      console.log("Harness event:", event.type);
      await chef.handleSessionEvent(sessionId, event as HarnessEvent);
    }
    console.log("Event stream ended, total events:", eventCount);

    // 4. Assert the task settled in a terminal state (completed/failed/cancelled).
    let settled: string | null = null;
    for (let i = 0; i < 200; i++) {
      const snap = chef.repository.getWorkspaceSnapshot(chef.workspaceId);
      const t = snap.tasks.find((x) => x.id === taskId);
      if (t && (t.status === "completed" || t.status === "failed" || t.status === "cancelled")) {
        settled = t.status;
        console.log("Task status:", t.status, t.resultSummary ?? "");
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!settled) throw new Error("task did not reach a terminal state within timeout");
    if (settled !== "completed") throw new Error(`expected completed, got ${settled}`);

    // 5. Every task in the workspace must be terminal.
    const finalSnap = chef.repository.getWorkspaceSnapshot(chef.workspaceId);
    const nonTerminal = finalSnap.tasks.filter(
      (t) => t.status !== "completed" && t.status !== "failed" && t.status !== "cancelled",
    );
    if (nonTerminal.length > 0) {
      throw new Error(`non-terminal tasks: ${nonTerminal.map((t) => `${t.id}:${t.status}`).join(", ")}`);
    }

    console.log("Smoke test PASSED — node created via API, dispatched, task completed.");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await chef.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});