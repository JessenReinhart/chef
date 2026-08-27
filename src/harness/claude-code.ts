/**
 * Chef P0 — Claude Code harness adapter (Phase 8)
 *
 * Binary detection (`claude`) + spawn config (env, cwd). Execution flows
 * through the generic PTY harness; this adapter owns the launch contract only.
 */

import { SpecializedCliHarness } from "./specialized.ts";
import type { SpecializedCliOptions } from "./specialized.ts";

type RuntimeOptions = Pick<SpecializedCliOptions, "workspaceId" | "cwd">;

export class ClaudeCodeHarness extends SpecializedCliHarness {
  constructor(binary = "claude", runtime: RuntimeOptions = {}) {
    super({
      id: "claude-code",
      type: "claude-code",
      name: "Claude Code",
      binary,
      taskArgs: (prompt) => ["-p", prompt],
      // Disable telemetry through the supported environment contract rather
      // than a CLI flag. Current Claude Code builds reject `--no-telemetry`,
      // which made every Chef-routed Claude task crash before execution.
      env: { CLAUDE_CODE_DISABLE_TELEMETRY: "1" },
      ...runtime,
    });
  }
}

/** Detect the `claude` binary (standalone helper for wiring). */
export async function detectClaudeCode(binary = "claude"): Promise<boolean> {
  return new ClaudeCodeHarness(binary).detect();
}
