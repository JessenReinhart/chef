/**
 * Chef P0 — Harness Registry (Phase 8)
 *
 * Specialized harness adapters (Claude Code, Pi, OMP, Freebuff) with binary
 * detection + spawn config; generic PTY fallback. Detects binaries at
 * startup; only available harnesses are registered. When no specialized
 * harness matches an agent, execution falls back to GenericTerminalHarness.
 */

import type { HarnessEvent, SpawnOptions } from "../harness/generic.ts";
import type { HarnessSession } from "../core/types.ts";
import { PiHarness } from "../harness/pi.ts";
import { OmpHarness } from "../harness/omp.ts";
import { FreebuffHarness } from "../harness/freebuff.ts";
import type { SpawnConfig } from "../core/types.ts";

/** Structural subset of a harness the scheduler drives. */
export interface HarnessLike {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  detect(): Promise<boolean>;
  spawn(config: SpawnConfig): Promise<HarnessSession>;
  send(sessionId: string, input: string): Promise<void>;
  resize(sessionId: string, cols: number, rows: number): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  terminate(sessionId: string): Promise<void>;
  kill(sessionId: string): Promise<void>;
  events(sessionId: string): AsyncIterable<HarnessEvent>;
  close(): Promise<void>;
}

export type { HarnessEvent, SpawnOptions, HarnessSession };

/** Detection result for one harness adapter. */
export interface HarnessDetection {
  id: string;
  name: string;
  available: boolean;
}

/** Specialized harness detection + spawn registry with generic fallback. */
export class HarnessRegistry {
  readonly #candidates: Array<{ id: string; name: string; make: () => HarnessLike }> = [];
  readonly #available = new Map<string, HarnessLike>();

  constructor() {
    this.register("claude-code", "Claude Code", () => new ClaudeCodeHarness());
    this.register("pi", "Pi", () => new PiHarness());
    this.register("omp", "OMP", () => new OmpHarness());
    this.register("freebuff", "Freebuff", () => new FreebuffHarness());
  }

  /** Register a specialized adapter (custom harnesses can be added at runtime). */
  register(id: string, name: string, make: () => HarnessLike): void {
    this.#candidates.push({ id, name, make });
  }

  /** Detect every candidate; only available harnesses are kept. */
  async initialize(): Promise<HarnessDetection[]> {
    const results: HarnessDetection[] = [];
    for (const candidate of this.#candidates) {
      try {
        const harness = candidate.make();
        const available = await harness.detect();
        if (available) this.#available.set(candidate.id, harness);
        results.push({ id: candidate.id, name: candidate.name, available });
      } catch {
        results.push({ id: candidate.id, name: candidate.name, available: false });
      }
    }
    return results;
  }

  get(id: string): HarnessLike | undefined {
    return this.#available.get(id);
  }

  values(): Iterable<HarnessLike> {
    return this.#available.values();
  }

  /** IDs of harnesses detected as available. */
  availableIds(): string[] {
    return [...this.#available.keys()];
  }

  /**
   * Spawn for an agent: prefer a specialized harness whose id matches the
   * agent id; otherwise generic PTY fallback with the provided command.
   */
  async spawnForAgent(
    agentId: string,
    workspaceId: string,
    command: string,
    args: string[],
    cwd: string,
    cols = 120,
    rows = 40,
  ): Promise<HarnessSession> {
    const specialized = this.#available.get(agentId);
    if (specialized) {
      return specialized.spawn({ workspaceId, command, args, cwd, cols, rows });
    }
    return new GenericTerminalHarness({ agentId, workspaceId, command, args, cwd }).spawn({ cols, rows });
  }

  /** Close every available harness. */
  async close(): Promise<void> {
    await Promise.allSettled([...this.#available.values()].map((harness) => harness.close()));
  }
}

export const harnessRegistry = new HarnessRegistry();
