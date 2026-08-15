import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createChef } from "../src/main.ts";

const dir = await mkdtemp(join(tmpdir(), "chef-pty-replay-"));
const dbPath = join(dir, "chef.sqlite");
const chef = createChef({ dbPath, projectDir: dir });

try {
  await chef.start();
  const result = await chef.sendUserMessage("Capture terminal output for replay");
  assert.equal(result.ok, true, `orchestrator failed: ${result.report}`);
  const snapshot = await chef.inspectState();
  const output = snapshot.events.filter((event) => event.type === "session.data");
  assert.ok(output.length > 0, "PTY output must be persisted as session.data events");
  const ordered = output.every((event, index) => index === 0 || event.seq > output[index - 1].seq);
  assert.equal(ordered, true, "PTY replay events must preserve sequence order");

  await chef.close();
  const reopened = createChef({ dbPath, projectDir: dir });
  await reopened.start();
  const restored = await reopened.inspectState();
  assert.equal(restored.events.filter((event) => event.type === "session.data").length, output.length);
  await reopened.close();
  console.log("pty-replay: ok — terminal output survives close/reopen");
} finally {
  await rm(dir, { recursive: true, force: true });
}
