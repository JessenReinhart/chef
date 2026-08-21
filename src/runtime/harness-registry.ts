/** Detects scheduler-compatible specialized CLI adapters. */
import { AiderHarness } from "../harness/aider.ts";
import { ClaudeCodeHarness } from "../harness/claude-code.ts";
import { CodexHarness } from "../harness/codex.ts";
import { DefaultTerminalHarness } from "../harness/default-terminal.ts";
import { PiHarness } from "../harness/pi.ts";
import { OmpHarness } from "../harness/omp.ts";
import { FreebuffHarness } from "../harness/freebuff.ts";
import type { HarnessLike } from "./scheduler.ts";

export interface DetectableHarness extends HarnessLike {
  readonly type: string;
  readonly name: string;
  detect(): Promise<boolean>;
}
export interface HarnessDetection {
  id: string;
  name: string;
  type: string;
  command: string;
  available: boolean;
}
export interface HarnessRegistryOptions { workspaceId?: string; cwd?: string; includeDefaults?: boolean; }

export class HarnessRegistry {
  readonly #candidates: Array<{ id: string; name: string; make: () => DetectableHarness }> = [];
  readonly #available = new Map<string, DetectableHarness>();
  #detections: HarnessDetection[] = [];

  constructor(options: HarnessRegistryOptions = {}) {
    if (options.includeDefaults === false) return;
    const runtime = { workspaceId: options.workspaceId, cwd: options.cwd };
    this.register("claude-code", "Claude Code", () => new ClaudeCodeHarness("claude", runtime));
    this.register("codex", "Codex", () => new CodexHarness("codex", runtime));
    this.register("aider", "Aider", () => new AiderHarness("aider", runtime));
    this.register("pi", "Pi", () => new PiHarness("pi", runtime));
    this.register("omp", "OMP", () => new OmpHarness("omp", runtime));
    this.register("freebuff", "Freebuff", () => new FreebuffHarness("freebuff", runtime));
    this.register("generic", "Generic Terminal", () => new DefaultTerminalHarness(runtime));
  }

  register(id: string, name: string, make: () => DetectableHarness): void { this.#candidates.push({ id, name, make }); }
  async initialize(): Promise<HarnessDetection[]> {
    await this.close();
    this.#available.clear();
    const results: HarnessDetection[] = [];
    for (const candidate of this.#candidates) {
      let harness: DetectableHarness | undefined;
      try {
        harness = candidate.make();
        const available = await harness.detect();
        if (available) this.#available.set(candidate.id, harness);
        else await harness.close();
        results.push({
          id: candidate.id,
          name: candidate.name,
          type: harness.type,
          command: harness.command,
          available,
        });
      } catch {
        if (harness) await harness.close().catch(() => undefined);
        results.push({
          id: candidate.id,
          name: candidate.name,
          type: harness?.type ?? candidate.id,
          command: harness?.command ?? candidate.id,
          available: false,
        });
      }
    }
    this.#detections = results.map((result) => ({ ...result }));
    return this.detections();
  }
  get(id: string): DetectableHarness | undefined { return this.#available.get(id); }
  values(): Iterable<DetectableHarness> { return this.#available.values(); }
  availableIds(): string[] { return [...this.#available.keys()]; }
  detections(): HarnessDetection[] { return this.#detections.map((result) => ({ ...result })); }
  async close(): Promise<void> { await Promise.allSettled([...this.#available.values()].map((h) => h.close())); }
}

export const harnessRegistry = new HarnessRegistry();