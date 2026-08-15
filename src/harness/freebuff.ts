/**
 * Chef P0 — Freebuff harness adapter (Phase 8)
 *
 * Binary detection (`freebuff`) + spawn config. Execution flows through the
 * generic PTY harness; this adapter owns the launch contract only.
 */

import { SpecializedCliHarness } from "./specialized.ts";

export class FreebuffHarness extends SpecializedCliHarness {
  constructor(binary = "freebuff") {
    super({
      id: "freebuff",
      type: "freebuff",
      name: "Freebuff",
      binary,
      flags: [],
    });
  }
}

/** Detect the `freebuff` binary (standalone helper for wiring). */
export async function detectFreebuff(binary = "freebuff"): Promise<boolean> {
  return new FreebuffHarness(binary).detect();
}
