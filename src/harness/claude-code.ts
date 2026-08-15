/**
 * Chef P0 — Claude Code harness adapter (Phase 8)
 *
 * Binary detection (`claude`) + spawn config (flags, env, cwd). Execution
 * flows through the generic PTY harness; this adapter owns the launch
 * contract only.
 */

import { SpecializedCliHarness } from "./specialized.ts";

export class ClaudeCodeHarness extends SpecializedCliHarness {
  constructor(binary = "claude") {
    super({
      id: "claude-code",
      type: "claude-code",
      name: "Claude Code",
      binary,
      flags: ["--no-telemetry"],
      env: { CLAUDE_CODE_DISABLE_TELEMETRY: "1" },
    });
  }
}

/** Detect the `claude` binary (standalone helper for wiring). */
export async function detectClaudeCode(binary = "claude"): Promise<boolean> {
  return new ClaudeCodeHarness(binary).detect();
}
