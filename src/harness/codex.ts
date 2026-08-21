/**
 * Chef — Codex CLI harness adapter.
 *
 * Binary detection (`codex`) + spawn config. Execution flows through the
 * generic PTY harness; this adapter owns the launch contract only.
 */

import { SpecializedCliHarness } from "./specialized.ts";
import type { SpecializedCliOptions } from "./specialized.ts";

type RuntimeOptions = Pick<SpecializedCliOptions, "workspaceId" | "cwd">;

export class CodexHarness extends SpecializedCliHarness {
  constructor(binary = "codex", runtime: RuntimeOptions = {}) {
    super({
      id: "codex",
      type: "codex",
      name: "Codex",
      binary,
      ...runtime,
    });
  }
}

/** Detect the `codex` binary (standalone helper for wiring). */
export async function detectCodex(binary = "codex"): Promise<boolean> {
  return new CodexHarness(binary).detect();
}
