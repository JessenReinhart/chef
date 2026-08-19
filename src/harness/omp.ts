/**
 * Chef P0 — OMP (Oh My Pi) harness adapter (Phase 8)
 *
 * Binary detection (`omp`) + spawn config. Execution flows through the
 * generic PTY harness; this adapter owns the launch contract only.
 */

import { SpecializedCliHarness } from "./specialized.ts";
import type { SpecializedCliOptions } from "./specialized.ts";

type RuntimeOptions = Pick<SpecializedCliOptions, "workspaceId" | "cwd">;

export class OmpHarness extends SpecializedCliHarness {
  constructor(binary = "omp", runtime: RuntimeOptions = {}) {
    super({
      id: "omp",
      type: "omp",
      name: "OMP",
      binary,
      flags: ["run"],
      ...runtime,
    });
  }
}

/** Detect the `omp` binary (standalone helper for wiring). */
export async function detectOmp(binary = "omp"): Promise<boolean> {
  return new OmpHarness(binary).detect();
}
