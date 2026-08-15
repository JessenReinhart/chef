import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createChef } from "../src/main.ts";

const dir = await mkdtemp(join(tmpdir(), "chef-live-event-failure-"));
const chef = createChef({ dbPath: join(dir, "chef.sqlite"), projectDir: dir });

try {
  await chef.start();
  const unsubscribe = chef.subscribeEvents(() => {
    throw new Error("inspector listener failed");
  });

  const result = await chef.sendUserMessage("A listener must not break execution");
  assert.equal(result.ok, true, `subscriber failure broke orchestration: ${result.report}`);
  const snapshot = await chef.inspectState();
  assert.ok(snapshot.events.length > 0, "runtime events must remain durable");
  unsubscribe();
  await chef.close();
  console.log("live-events-failure: ok — listener failures cannot abort runtime writes");
} finally {
  await rm(dir, { recursive: true, force: true });
}
