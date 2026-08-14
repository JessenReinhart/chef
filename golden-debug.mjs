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

console.error("=== BEFORE FIRST close ===");
let h = process._getActiveHandles();
console.error(`handles: ${h.length}`);
h.forEach((x, i) => console.error(`  [${i}] ${x.constructor?.name}`));

await chef.close();

console.error("=== AFTER FIRST close ===");
h = process._getActiveHandles();
console.error(`handles: ${h.length}`);
h.forEach((x, i) => {
  console.error(`  [${i}] ${x.constructor?.name} _handle=${x._handle?.constructor?.name ?? 'null'} _type=${x._type ?? 'N/A'} _isStdio=${x._isStdio ?? 'N/A'}`);
});

const reopened = createChef({ dbPath, projectDir });
await reopened.start();
await reopened.close();

console.error("=== AFTER SECOND close ===");
h = process._getActiveHandles();
console.error(`handles: ${h.length}`);
h.forEach((x, i) => console.error(`  [${i}] ${x.constructor?.name}`));

try {
  await rm(projectDir, { recursive: true, force: true });
  console.error("rm: OK");
} catch (e) {
  console.error(`rm FAILED: ${e.code} ${e.message}`);
}
process.exit(0);
