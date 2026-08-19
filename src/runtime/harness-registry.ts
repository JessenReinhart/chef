/** Detects scheduler-compatible specialized CLI adapters. */
import { ClaudeCodeHarness } from "../harness/claude-code.ts";
import { PiHarness } from "../harness/pi.ts";
import { OmpHarness } from "../harness/omp.ts";
import { FreebuffHarness } from "../harness/freebuff.ts";
import type { HarnessLike } from "./scheduler.ts";

export interface DetectableHarness extends HarnessLike {
  readonly type: string;
  readonly name: string;
  detect(): Promise<boolean>;
}
export interface HarnessDetection { id: string; name: string; available: boolean; }
export interface HarnessRegistryOptions { workspaceId?: string; cwd?: string; includeDefaults?: boolean; }

export class HarnessRegistry {
  readonly #candidates: Array<{ id: string; name: string; make: () => DetectableHarness }> = [];
  readonly #available = new Map<string, DetectableHarness>();

  constructor(options: HarnessRegistryOptions = {}) {
    if (options.includeDefaults === false) return;
    const runtime = { workspaceId: options.workspaceId, cwd: options.cwd };
    this.register("claude-code", "Claude Code", () => new ClaudeCodeHarness("claude", runtime));
    this.register("pi", "Pi", () => new PiHarness("pi", runtime));
    this.register("omp", "OMP", () => new OmpHarness("omp", runtime));
    this.register("freebuff", "Freebuff", () => new FreebuffHarness("freebuff", runtime));
  }

  register(id: string, name: string, make: () => DetectableHarness): void { this.#candidates.push({ id, name, make }); }
  async initialize(): Promise<HarnessDetection[]> {
    await this.close();
    this.#available.clear();
    const results: HarnessDetection[] = [];
    for (const candidate of this.#candidates) {
      try {
        const harness = candidate.make();
        const available = await harness.detect();
        if (available) this.#available.set(candidate.id, harness);
        else await harness.close();
        results.push({ id: candidate.id, name: candidate.name, available });
      } catch {
        results.push({ id: candidate.id, name: candidate.name, available: false });
      }
    }
    return results;
  }
  get(id: string): DetectableHarness | undefined { return this.#available.get(id); }
  values(): Iterable<DetectableHarness> { return this.#available.values(); }
  availableIds(): string[] { return [...this.#available.keys()]; }
  async close(): Promise<void> { await Promise.allSettled([...this.#available.values()].map((h) => h.close())); }
}

export const harnessRegistry = new HarnessRegistry();
