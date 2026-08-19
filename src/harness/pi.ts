/**
 * Chef P0 — Pi harness adapter (Phase 8)
 *
 * Binary detection (`pi`) + spawn config. Execution flows through the
 * generic PTY harness; this adapter owns the launch contract only.
 */

import { SpecializedCliHarness } from "./specialized.ts";
import type { SpecializedCliOptions } from "./specialized.ts";

type RuntimeOptions = Pick<SpecializedCliOptions, "workspaceId" | "cwd">;

export class PiHarness extends SpecializedCliHarness {
  constructor(binary = "pi", runtime: RuntimeOptions = {}) {
    super({
      id: "pi",
      type: "pi",
      name: "Pi",
      binary,
      flags: [],
      ...runtime,
    });
  }
}

/** Detect the `pi` binary (standalone helper for wiring). */
export async function detectPi(binary = "pi"): Promise<boolean> {
  return new PiHarness(binary).detect();
}
