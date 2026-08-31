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

const serializedRoot = await mkdtemp(join(tmpdir(), "chef-serialized-result-"));
const serializedWorkerPath = join(serializedRoot, "serialized-result-worker.cjs");
const serializedMarker = "serialized-worker-result";

await writeFile(serializedWorkerPath, String.raw`
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const sessionId = process.env.CHEF_SESSION_ID;
if (!sessionId) throw new Error("CHEF_SESSION_ID is required");
const outbox = path.join(os.tmpdir(), "chef-sideband", sessionId, "outbox");
setTimeout(() => {
  fs.mkdirSync(outbox, { recursive: true });
  const envelope = {
    version: 1,
    id: crypto.randomUUID(),
    kind: "artifact",
    from: "process",
    payload: { type: "result", name: ${JSON.stringify(serializedMarker)}, uri: "file:///serialized-result.txt" },
    timestamp: Date.now()
  };
  fs.writeFileSync(path.join(outbox, envelope.id + ".json"), JSON.stringify(envelope));
}, 20);
setTimeout(() => process.exit(0), 140);
`, "utf8");

const serializedHarness = new GenericTerminalHarness(
  {
    agentId: "serialized-result-worker",
    workspaceId: "serialized-result-workspace",
    command: process.execPath,
    args: [serializedWorkerPath],
    cwd: serializedRoot,
  },
  { pollIntervalMs: 5 },
);

try {
  const session = await serializedHarness.spawn();
  const originalReadOutbox = session.sideband.readOutbox.bind(session.sideband);
  let inFlightReads = 0;
  let maxConcurrentReads = 0;
  session.sideband.readOutbox = async () => {
    inFlightReads += 1;
    maxConcurrentReads = Math.max(maxConcurrentReads, inFlightReads);
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return await originalReadOutbox();
    } finally {
      inFlightReads -= 1;
    }
  };

  const events: HarnessEvent[] = [];
  for await (const event of serializedHarness.events(session.id)) events.push(event);

  const matchingResults = events.filter((event) => {
    if (event.type !== "structured" || typeof event.payload !== "object" || event.payload === null) return false;
    const envelope = event.payload as { payload?: { name?: unknown } };
    return envelope.payload?.name === serializedMarker;
  });

  assert.equal(maxConcurrentReads, 1, "sideband polling must serialize slow filesystem drains instead of reading the same result concurrently");
  assert.equal(matchingResults.length, 1, "one durable worker result must produce exactly one structured handoff event");
} finally {
  await serializedHarness.close();
  await rm(serializedRoot, { recursive: true, force: true });
}

console.log("fast-worker-result-handoff: ok — fast results survive exit and sideband polling cannot duplicate handoff events");
