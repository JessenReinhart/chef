import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChef } from "file:///C:/Users/LGSM228/chef/src/main.ts";

const projectDir = await mkdtemp(join(tmpdir(), "chef-golden-project-"));
const dbPath = join(projectDir, "chef.sqlite");

const chef = createChef({ dbPath, projectDir });
await chef.start();
const result = await chef.sendUserMessage("Investigate and fix this bug");
assert.equal(result.ok, true, `orchestrator failed: ${result.report}`);

const snapshot = await chef.inspectState();
assert.ok(snapshot.tasks.every((task) => task.status === "completed"), "tasks must complete");
const messagesBeforeClose = chef.repository.listMessages(chef.workspaceId);
assert.ok(messagesBeforeClose.length > 0, "messages must persist");

await chef.close();

const reopened = createChef({ dbPath, projectDir });
await reopened.start();
const restored = await reopened.inspectState();
assert.equal(restored.tasks.length, snapshot.tasks.length);
const messagesAfterReopen = reopened.repository.listMessages(chef.workspaceId);
assert.equal(messagesAfterReopen.length, messagesBeforeClose.length);
await reopened.close();

console.error("=== BEFORE rm ===");
process._getActiveHandles().forEach((x, i) => {
  console.error(`  [${i}] ${x.constructor?.name} _handle=${x._handle?.constructor?.name ?? 'null'} _isStdio=${x._isStdio ?? 'N/A'}`);
});

for (let attempt = 1; attempt <= 5; attempt++) {
  try {
    await rm(projectDir, { recursive: true, force: true });
    console.error(`rm OK on attempt ${attempt}`);
    break;
  } catch (e) {
    console.error(`rm attempt ${attempt} FAILED: ${e.code}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
process.exit(0);
