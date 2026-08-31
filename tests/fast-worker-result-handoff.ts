import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenericTerminalHarness, type HarnessEvent } from "../src/harness/generic.ts";

const root = await mkdtemp(join(tmpdir(), "chef-fast-result-"));
const workerPath = join(root, "fast-result-worker.cjs");
const marker = "fast-worker-result";

await writeFile(workerPath, String.raw`
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const sessionId = process.env.CHEF_SESSION_ID;
if (!sessionId) throw new Error("CHEF_SESSION_ID is required");
const outbox = path.join(os.tmpdir(), "chef-sideband", sessionId, "outbox");
fs.mkdirSync(outbox, { recursive: true });
const envelope = {
  version: 1,
  id: crypto.randomUUID(),
  kind: "artifact",
  from: "process",
  payload: { type: "result", name: ${JSON.stringify(marker)}, uri: "file:///fast-result.txt" },
  timestamp: Date.now()
};
fs.writeFileSync(path.join(outbox, envelope.id + ".json"), JSON.stringify(envelope));
`, "utf8");

const harness = new GenericTerminalHarness(
  {
    agentId: "fast-result-worker",
    workspaceId: "fast-result-workspace",
    command: process.execPath,
    args: [workerPath],
    cwd: root,
  },
  // Make normal polling impossible during this short-lived worker. The result
  // can only survive if exit teardown performs its final outbox drain.
  { pollIntervalMs: 60_000 },
);

try {
  const session = await harness.spawn();
  const events: HarnessEvent[] = [];
  for await (const event of harness.events(session.id)) events.push(event);

  const structuredIndex = events.findIndex((event) => {
    if (event.type !== "structured" || typeof event.payload !== "object" || event.payload === null) return false;
    const envelope = event.payload as { payload?: { name?: unknown } };
    return envelope.payload?.name === marker;
  });
  const exitIndex = events.findIndex((event) => event.type === "exit" && event.exitCode === 0);

  assert.ok(structuredIndex >= 0, "a result written immediately before worker exit must not be lost between outbox polls");
  assert.ok(exitIndex > structuredIndex, "the final structured result must be observable before the terminal exit event");
} finally {
  await harness.close();
  await rm(root, { recursive: true, force: true });
}

console.log("fast-worker-result-handoff: ok — immediate worker results survive exit before the next sideband poll");
