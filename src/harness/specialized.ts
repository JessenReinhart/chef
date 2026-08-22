/** Persistent specialized CLI adapter backed by one GenericTerminalHarness. */
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { GenericTerminalHarness } from "./generic.ts";
import type { HarnessEvent, HarnessSession, SpawnOptions } from "./generic.ts";
import type { ContextReference } from "./sideband.ts";

export interface SpecializedCliOptions {
  id: string;
  type: string;
  name: string;
  binary: string;
  flags?: string[];
  /**
   * Build a one-shot CLI invocation for a Mission Task. When omitted the
   * adapter remains interactive-only and must not be auto-routed for Mission
   * execution.
   */
  taskArgs?: (prompt: string) => string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  workspaceId?: string;
  sidebandRoot?: string;
  pollIntervalMs?: number;
}

export type SpecializedSpawnOptions = SpawnOptions & { taskPrompt?: string };

export interface TaskLaunch {
  command: string;
  args: string[];
}

export class SpecializedCliHarness {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly #binary: string;
  readonly #flags: string[];
  readonly #taskArgs: ((prompt: string) => string[]) | undefined;
  readonly #env: Record<string, string | undefined>;
  readonly #cwd: string;
  readonly #harness: GenericTerminalHarness;
  #closePromise: Promise<void> | undefined;

  constructor(options: SpecializedCliOptions) {
    this.id = options.id;
    this.type = options.type;
    this.name = options.name;
    this.#binary = options.binary;
    this.#flags = [...(options.flags ?? [])];
    this.#taskArgs = options.taskArgs;
    this.#env = { ...(options.env ?? {}) };
    this.#cwd = options.cwd ?? process.cwd();
    this.#harness = new GenericTerminalHarness(
      {
        agentId: options.id,
        workspaceId: options.workspaceId ?? "specialized",
        command: this.#binary,
        args: this.#flags,
        cwd: this.#cwd,
        env: this.#env,
      },
      { sidebandRoot: options.sidebandRoot, pollIntervalMs: options.pollIntervalMs },
    );
  }

  get command(): string { return this.#binary; }
  get args(): string[] { return [...this.#flags]; }
  get cwd(): string { return this.#cwd; }
  get taskCapable(): boolean { return this.#taskArgs !== undefined; }

  taskLaunch(prompt: string): TaskLaunch {
    if (!this.#taskArgs) {
      throw new Error(`${this.name} does not support bounded Mission task execution`);
    }
    return { command: this.#binary, args: this.#taskArgs(prompt) };
  }

  async detect(): Promise<boolean> {
    if (isAbsolute(this.#binary) || this.#binary.includes("/") || this.#binary.includes("\\")) {
      return this.#canAccess(this.#binary);
    }
    const extensions = process.platform === "win32"
      ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)]
      : [""];
    for (const dir of (process.env.PATH ?? "").split(delimiter)) {
      if (!dir) continue;
      for (const extension of extensions) {
        if (await this.#canAccess(join(dir, this.#binary + extension))) return true;
      }
    }
    return false;
  }

  async #canAccess(path: string): Promise<boolean> {
    try {
      await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  spawn(options: SpecializedSpawnOptions = {}): Promise<HarnessSession> {
    const args = options.taskPrompt !== undefined
      ? this.taskLaunch(options.taskPrompt).args
      : this.#flags;
    return this.#harness.spawn({
      sessionId: options.sessionId,
      command: this.#binary,
      args,
      cwd: options.cwd ?? this.#cwd,
      env: { ...this.#env, ...options.env },
      cols: options.cols ?? 120,
      rows: options.rows ?? 40,
    });
  }

  send(sessionId: string, input: string): Promise<void> { return this.#harness.send(sessionId, input); }
  resize(sessionId: string, cols: number, rows: number): Promise<void> { return this.#harness.resize(sessionId, cols, rows); }
  interrupt(sessionId: string): Promise<void> { return this.#harness.interrupt(sessionId); }
  terminate(sessionId: string): Promise<void> { return this.#harness.terminate(sessionId); }
  kill(sessionId: string): Promise<void> { return this.#harness.kill(sessionId); }
  events(sessionId: string): AsyncIterable<HarnessEvent> { return this.#harness.events(sessionId); }
  writeContextRefs(sessionId: string, refs: ContextReference[]): Promise<string> { return this.#harness.writeContextRefs(sessionId, refs); }
  writeMessage(sessionId: string, from: string, text: string): Promise<string> { return this.#harness.writeMessage(sessionId, from, text); }
  forget(sessionId: string): Promise<void> { return this.#harness.forget(sessionId); }
  close(): Promise<void> {
    this.#closePromise ??= this.#harness.close();
    return this.#closePromise;
  }
}
