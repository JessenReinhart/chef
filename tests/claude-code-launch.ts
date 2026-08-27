import assert from "node:assert/strict";

import { ClaudeCodeHarness } from "../src/harness/claude-code.ts";

const harness = new ClaudeCodeHarness("claude", { workspaceId: "test-workspace", cwd: process.cwd() });

try {
  assert.deepEqual(
    harness.args,
    [],
    "interactive Claude Code launch must not include unsupported global CLI flags",
  );

  const launch = harness.taskLaunch("Create a simple todo app");
  assert.equal(launch.command, "claude");
  assert.deepEqual(
    launch.args,
    ["-p", "Create a simple todo app"],
    "bounded Claude Code tasks should use print mode without the removed --no-telemetry flag",
  );
  assert.equal(
    launch.args.includes("--no-telemetry"),
    false,
    "Chef must never reintroduce the Claude Code flag that crashes current CLI builds",
  );

  console.log("claude-code-launch: ok — current Claude Code CLI receives only supported bounded-task arguments");
} finally {
  await harness.close();
}
