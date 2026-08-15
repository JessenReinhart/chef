import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createChef } from "../src/main.ts";
import type { RuntimeEvent } from "../src/core/types.ts";

const dir = await mkdtemp(join(tmpdir(), "chef-live-events-"));
const chef = createChef({ dbPath: join(dir, "chef.sqlite"), projectDir: dir });

try {
  await chef.start();
  const received: RuntimeEvent[] = [];
  const unsubscribe = chef.subscribeEvents((event) => received.push(event));

  const result = await chef.sendUserMessage("Stream runtime events live");
  assert.equal(result.ok, true, `orchestrator failed: ${result.report}`);

  assert.ok(received.length > 0, "live subscriber must receive runtime events");
  assert.ok(
    received.some((event) => event.type.startsWith("task.")),
    "live events must include task lifecycle transitions",
  );
  const snapshot = await chef.inspectState();
  assert.equal(snapshot.events.length, received.length, "persisted events must match live stream");

  unsubscribe();
  const before = received.length;
  const second = await chef.sendUserMessage("Second run must not reach unsubscribed listener");
  assert.equal(second.ok, true, `orchestrator failed: ${second.report}`);
  assert.equal(received.length, before, "unsubscribed listener must not receive further events");

  await chef.close();
  console.log("live-events: ok — subscriber receives persisted stream, unsubscribe stops delivery");
} finally {
  await rm(dir, { recursive: true, force: true });
}
