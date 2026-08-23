import assert from "node:assert/strict";
import { ClaudeCodeHarness } from "../src/harness/claude-code.ts";
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

const claude = new ClaudeCodeHarness("chef-definitely-missing-claude-binary");
try {
  assert.equal(claude.id, "claude-code");
  assert.equal(claude.command, "chef-definitely-missing-claude-binary");
  assert.deepEqual(claude.args, [], "interactive Claude launch must not include stale CLI flags");
  assert.equal(await claude.detect(), false, "Claude Code adapter should use executable readiness detection");
  const prompt = "create the proof file";
  const launch = claude.taskLaunch(prompt);
  assert.deepEqual(launch.args, ["-p", prompt], "bounded Claude Mission work should use print mode only");
  assert.equal(launch.args.includes("--no-telemetry"), false, "removed Claude CLI flags must not return");
} finally {
  await claude.close();
}

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

console.log("codex-harness: ok — Codex and Claude launch contracts");
