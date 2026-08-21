import assert from "node:assert/strict";
import { CodexHarness } from "../src/harness/codex.ts";
import { HarnessRegistry } from "../src/runtime/harness-registry.ts";

const harness = new CodexHarness("chef-definitely-missing-codex-binary");
assert.equal(harness.id, "codex");
assert.equal(harness.type, "codex");
assert.equal(harness.name, "Codex");
assert.equal(harness.command, "chef-definitely-missing-codex-binary");
assert.deepEqual(harness.args, []);
assert.equal(await harness.detect(), false, "Codex adapter should use executable readiness detection");
await harness.close();

const registry = new HarnessRegistry();
try {
  const detections = await registry.initialize();
  const codex = detections.find((item) => item.id === "codex");
  assert.ok(codex, "default registry should expose Codex readiness");
  assert.equal(codex.name, "Codex");
  assert.equal(codex.type, "codex");
  assert.equal(codex.command, "codex");
  assert.equal(typeof codex.available, "boolean");
} finally {
  await registry.close();
}

console.log("codex-harness: ok");
