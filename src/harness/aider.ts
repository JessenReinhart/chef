/**
 * Chef — Aider CLI harness adapter.
 *
 * Binary detection (`aider`) + spawn config. Execution flows through the
 * generic PTY harness; this adapter owns the launch contract only.
 */

import { SpecializedCliHarness } from "./specialized.ts";
import type { SpecializedCliOptions } from "./specialized.ts";

type RuntimeOptions = Pick<SpecializedCliOptions, "workspaceId" | "cwd">;

export class AiderHarness extends SpecializedCliHarness {
  constructor(binary = "aider", runtime: RuntimeOptions = {}) {
    super({
      id: "aider",
      type: "aider",
      name: "Aider",
      binary,
      ...runtime,
    });
  }
}

/** Detect the `aider` binary (standalone helper for wiring). */
export async function detectAider(binary = "aider"): Promise<boolean> {
  return new AiderHarness(binary).detect();
}
