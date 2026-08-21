import assert from "node:assert/strict";
import { AiderHarness } from "../src/harness/aider.ts";
import { HarnessRegistry } from "../src/runtime/harness-registry.ts";

const harness = new AiderHarness("chef-definitely-missing-aider-binary");
assert.equal(harness.id, "aider");
assert.equal(harness.type, "aider");
assert.equal(harness.name, "Aider");
assert.equal(harness.command, "chef-definitely-missing-aider-binary");
assert.deepEqual(harness.args, []);
assert.equal(await harness.detect(), false, "Aider adapter should use executable readiness detection");
await harness.close();

const registry = new HarnessRegistry();
try {
  const detections = await registry.initialize();
  const aider = detections.find((item) => item.id === "aider");
  assert.ok(aider, "default registry should expose Aider readiness");
  assert.equal(aider.name, "Aider");
  assert.equal(aider.type, "aider");
  assert.equal(aider.command, "aider");
  assert.equal(typeof aider.available, "boolean");
} finally {
  await registry.close();
}

console.log("aider-harness: ok");
