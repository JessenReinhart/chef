/**
 * Chef P0 — Specialized CLI harness base (Phase 8)
 *
 * Shared implementation for the Claude Code / Pi / OMP / Freebuff adapters:
 * binary detection + spawn config, running through the generic PTY harness
 * (which owns session tracking, sidebands, and teardown). Every adapter
 * method delegates to an internal GenericTerminalHarness — no duplicated
 * PTY logic.
 */

import { GenericTerminalHarness } from "./generic.ts";
import type { HarnessEvent, HarnessSession, SpawnOptions } from "./generic.ts";
import type { SpawnConfig } from "../core/types.ts";

export interface SpecializedCliOptions {
  id: string;
  type: string;
  name: string;
  binary: string;
  /** Extra CLI flags applied to every spawn. */
  flags?: string[];
  /** Env merged over process.env for every spawn. */
  env?: Record<string, string | undefined>;
  /** Default working directory (falls back to process.cwd()). */
  cwd?: string;
}

export class SpecializedCliHarness {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly #binary: string;
  readonly #flags: string[];
  readonly #env: Record<string, string | undefined>;
  readonly #cwd: string | undefined;

  constructor(options: SpecializedCliOptions) {
    this.id = options.id;
    this.type = options.type;
    this.name = options.name;
    this.#binary = options.binary;
    this.#flags = options.flags ?? [];
    this.#env = options.env ?? {};
    this.#cwd = options.cwd;
  }

  /** Scheduler-compatible command surface (resolved at spawn time). */
  get command(): string {
    return this.#binary;
  }
  get args(): string[] {
    return [...this.#flags];
  }
  get cwd(): string {
    return this.#cwd ?? process.cwd();
  }

  /** Binary availability on PATH (absolute paths pass through). */
  async detect(): Promise<boolean> {
    const { access } = await import("node:fs/promises");
    if (this.#binary.includes("/")) {
      try {
        await access(this.#binary);
        return true;
      } catch {
        return false;
      }
    }
    const { delimiter } = await import("node:path");
    for (const dir of (process.env.PATH ?? "").split(delimiter)) {
      if (dir === "") continue;
      try {
        await access(`${dir}/${this.#binary}`);
        return true;
      } catch {
        // keep walking
      }
    }
    return false;
  }

  /** Spawn a session through the generic PTY harness. */
  async spawn(config: SpawnConfig): Promise<HarnessSession> {
    const cwd = config.cwd ?? this.#cwd ?? process.cwd();
    const harness = new GenericTerminalHarness({
      agentId: config.workspaceId,
      workspaceId: config.workspaceId,
      command: this.#binary,
      args: this.#flags,
      cwd,
      env: this.#env,
    });
    return harness.spawn(this.#spawnOptions(config, cwd));
  }

  #spawnOptions(config: SpawnConfig, cwd: string): SpawnOptions {
    return {
      sessionId: config.workspaceId,
      command: this.#binary,
      args: this.#flags,
      cwd,
      env: this.#env,
      cols: config.cols ?? 120,
      rows: config.rows ?? 40,
    };
  }

  /** Delegate live-session control to a generic harness for the given session. */
  #harnessFor(): GenericTerminalHarness {
    return new GenericTerminalHarness({
      agentId: "specialized",
      workspaceId: "specialized",
      command: this.#binary,
      args: this.#flags,
      cwd: this.#cwd,
      env: this.#env,
    });
  }

  async send(sessionId: string, input: string): Promise<void> {
    await this.#harnessFor().send(sessionId, input);
  }
  async resize(sessionId: string, cols: number, rows: number): Promise<void> {
    await this.#harnessFor().resize(sessionId, cols, rows);
  }
  async interrupt(sessionId: string): Promise<void> {
    await this.#harnessFor().interrupt(sessionId);
  }
  async terminate(sessionId: string): Promise<void> {
    await this.#harnessFor().terminate(sessionId);
  }
  async kill(sessionId: string): Promise<void> {
    await this.#harnessFor().kill(sessionId);
  }
  events(sessionId: string): AsyncIterable<HarnessEvent> {
    return this.#harnessFor().events(sessionId);
  }
  async close(): Promise<void> {
    await this.#harnessFor().close();
  }
}
