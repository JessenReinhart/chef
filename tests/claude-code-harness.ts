import assert from "node:assert/strict";
import { ClaudeCodeHarness } from "../src/harness/claude-code.ts";

const harness = new ClaudeCodeHarness("chef-definitely-missing-claude-binary");
try {
  assert.equal(harness.id, "claude-code");
  assert.equal(harness.type, "claude-code");
  assert.equal(harness.name, "Claude Code");
  assert.equal(harness.command, "chef-definitely-missing-claude-binary");
  assert.deepEqual(harness.args, [], "interactive Claude launch must not include stale CLI flags");
  assert.equal(await harness.detect(), false, "Claude Code adapter should use executable readiness detection");

  const prompt = "create the proof file";
  const launch = harness.taskLaunch(prompt);
  assert.equal(launch.command, "chef-definitely-missing-claude-binary");
  assert.deepEqual(launch.args, ["-p", prompt], "bounded Claude Mission work should use print mode only");
  assert.equal(launch.args.includes("--no-telemetry"), false, "removed Claude CLI flags must not return");

  console.log("claude-code-harness: ok");
} finally {
  await harness.close();
}
