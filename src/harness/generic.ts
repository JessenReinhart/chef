import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { spawn as ptySpawn } from "node-pty";
import type { IPty } from "node-pty";
import type { ContextReference, SidebandEnvelope } from "./sideband.ts";
import { SidebandDirectory, defaultSidebandRoot } from "./sideband.ts";

/**
 * Harness events: terminal output (`data`) is delivered verbatim; lifecycle
 * transitions are classified as graceful `exit` (exit code 0 or intentionally
 * terminated) vs `crash` (non-zero exit / signal). Structured platform
 * communication arrives via the outbox and is surfaced as `structured` events,
 * never mixed into PTY output.
 */
export type HarnessEvent =
  | { type: "data"; data: string }
  | { type: "exit"; exitCode: number }
  | { type: "crash"; exitCode: number }
  | { type: "structured"; payload: unknown };

export type SessionStatus = "spawning" | "running" | "completed" | "crashed" | "terminated";

export interface GenericHarnessConfig {
  agentId: string;
  workspaceId: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export interface SpawnOptions {
  sessionId?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  cols?: number;
  rows?: number;
}

export interface HarnessSession {
  /** Session id — caller-supplied or auto-generated. */
  id: string;
  pid: number;
  command: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  status: SessionStatus;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  /** Sideband directories (inbox/outbox) for this session. */
  sideband: SidebandDirectory;
}

export interface Harness {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  detect(): Promise<boolean>;
  spawn(config?: SpawnOptions): Promise<HarnessSession>;
  send(sessionId: string, input: string): Promise<void>;
  resize(sessionId: string, cols: number, rows: number): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  terminate(sessionId: string): Promise<void>;
  kill(sessionId: string): Promise<void>;
  events(sessionId: string): AsyncIterable<HarnessEvent>;
  close(): Promise<void>;
}

/**
 * node-pty on Windows requires an absolute or PATH-resolvable executable:
 * unlike POSIX (where fork/execvp searches PATH), winpty returns
 * "File not found" for a bare command like `node`. Walk PATH using PATHEXT
 * so callers can spawn `node`/`cmd` without knowing their install location.
 */
function resolveExecutable(command: string): string {
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) return command;
  if (process.platform !== "win32") return command;
  const extensions = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const base = join(dir, command);
    if (existsSync(base)) return base;
    for (const ext of extensions) {
      const candidate = base + ext;
      if (existsSync(candidate)) return candidate;
    }
  }
  return command;
}

/**
 * Best-effort access to node-pty's private Windows backend internals
 * (`WindowsTerminal._agent`). These fields are not part of the public IPty
 * surface, so every read is guarded and every call is a no-op on mismatch.
 */

/** Read one field off an unknown object without throwing. */
function readField(target: object, key: string): unknown {
  const record = target as Record<string, unknown>;
  return key in record ? record[key] : undefined;
}

/** Call `.destroy()` on a socket-like value (net.Socket) if present. */
function destroySocket(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  const destroy = readField(value, "destroy");
  if (typeof destroy === "function") {
    try { destroy.call(value); } catch { /* already destroyed */ }
  }
}

/**
 * Terminate the ConoutConnection worker thread immediately instead of
 * waiting for its 1-second FLUSH_DATA_INTERVAL drain timeout, and cancel
 * that timer so it cannot keep the event loop alive.
 */
function terminateConoutWorker(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  // Prevent a deferred node-pty dispose() from arming a new drain timer.
  const conout = value as Record<string, unknown>;  // node-pty private fields
  conout._isDisposed = true;
  const drainTimeout = readField(conout, "_drainTimeout");
  if (typeof drainTimeout === "object" && drainTimeout !== null) {
    try { clearTimeout(drainTimeout as NodeJS.Timeout); } catch { /* ignore */ }
  }
  const worker = readField(conout, "_worker");
  if (typeof worker !== "object" || worker === null) return;
  const terminate = readField(worker, "terminate");
  if (typeof terminate === "function") {
    try { void terminate.call(worker); } catch { /* ignore */ }
  }
}

/** Async queue backing a session's event stream; safe for several consumers. */
class SessionQueue implements AsyncIterable<HarnessEvent> {
  #buffer: HarnessEvent[] = [];
  #waiters: {
    resolve: (r: IteratorResult<HarnessEvent>) => void;
    reject: (e: unknown) => void;
  }[] = [];
  #closed = false;
  #error: unknown = null;

  push(event: HarnessEvent): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ value: event, done: false });
    else this.#buffer.push(event);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters) waiter.resolve({ value: undefined, done: true });
    this.#waiters = [];
  }

  fail(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#error = error;
    for (const waiter of this.#waiters) waiter.reject(error);
    this.#waiters = [];
  }

  async *[Symbol.asyncIterator](): AsyncIterator<HarnessEvent> {
    while (true) {
      const buffered = this.#buffer.shift();
      if (buffered) {
        yield buffered;
        continue;
      }
      if (this.#closed) {
        if (this.#error !== null) throw this.#error;
        return;
      }
      const { promise, resolve, reject } = Promise.withResolvers<IteratorResult<HarnessEvent>>();
      this.#waiters.push({ resolve, reject });
      const result = await promise;
      if (result.done) return;
      yield result.value;
    }
  }
}

interface ActiveSession {
  session: HarnessSession;
  pty: IPty;
  queue: SessionQueue;
  /** True once terminate()/kill() requested a stop (classifies as graceful exit). */
  intentionalStop: boolean;
  /** Non-zero when the process was killed by a signal. */
  signal?: number;
  /** Outbox poll timer; cleared when the session exits. */
  watcher?: ReturnType<typeof setInterval>;
}

/**
 * GenericTerminalHarness — mandatory P0 adapter that launches arbitrary
 * interactive CLI processes in a real PTY (node-pty; winpty on Windows for
 * stability; ConPTY optional). Terminal I/O and structured communication are
 * separate channels: PTY bytes stream as `data` events, structured envelopes
 * arrive through the sideband outbox as `structured` events.
 */
export class GenericTerminalHarness implements Harness {
  readonly id: string;
  readonly type = "generic";
  readonly name = "Generic Terminal";
  readonly agentId: string;
  readonly workspaceId: string;
  readonly command: string;
  readonly args: string[];
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly #sidebandRoot: string;
  readonly #pollIntervalMs: number;
  readonly #sessions = new Map<string, ActiveSession>();
  /** Queues of finished sessions stay readable (stream attachment may race exit). */
  readonly #endedQueues = new Map<string, SessionQueue>();

  constructor(
    config: GenericHarnessConfig,
    opts?: { sidebandRoot?: string; pollIntervalMs?: number },
  ) {
    this.id = config.agentId;
    this.agentId = config.agentId;
    this.workspaceId = config.workspaceId;
    this.command = config.command;
    this.args = config.args ?? [];
    this.cwd = config.cwd;
    this.env = config.env;
    this.#sidebandRoot = opts?.sidebandRoot ?? defaultSidebandRoot();
    this.#pollIntervalMs = opts?.pollIntervalMs ?? 250;
  }

  /** Static registry check — the generic adapter is available when node-pty loads. */
  static async detect(): Promise<boolean> {
    return typeof ptySpawn === "function";
  }

  /** Instance form of detect() for the Harness interface. */
  async detect(): Promise<boolean> {
    return typeof ptySpawn === "function";
  }

  async spawn(options: SpawnOptions = {}): Promise<HarnessSession> {
    const sessionId = options.sessionId ?? randomUUID();
    const rawCommand = options.command ?? this.command;
    const command = resolveExecutable(rawCommand);
    const args = options.args ?? this.args;
    const cwd = options.cwd ?? this.cwd ?? process.cwd();
    const cols = options.cols ?? 80;
    const rows = options.rows ?? 24;
    const env = { ...process.env, ...this.env, CHEF_SESSION_ID: sessionId, ...options.env };
    const sideband = new SidebandDirectory(sessionId, this.#sidebandRoot);
    await sideband.init();

    // Windows: default to ConPTY, but some Windows builds crash in ConPTY's
    // exit-time cleanup (AttachConsole failed), surfacing as an abnormal
    // exitCode. Prefer winpty's battle-tested path unless ConPTY is forced.
    let pty: IPty;
    try {
      pty = ptySpawn(command, args, {
        cols, rows, cwd, env,
        ...(process.platform === "win32" ? { useConpty: false } : {}),
      });
    } catch (error) {
      await sideband.dispose();
      throw error;
    }

    const queue = new SessionQueue();
    const session: HarnessSession = {
      id: sessionId,
      pid: pty.pid,
      command,
      args,
      cwd,
      cols,
      rows,
      status: "running",
      startedAt: Date.now(),
      sideband,
    };
    const active: ActiveSession = { session, pty, queue, intentionalStop: false };

    pty.onData((data) => {
      if (data.length > 0) queue.push({ type: "data", data });
    });

    pty.onExit(({ exitCode, signal }) => {
      if (signal !== undefined) active.signal = signal;
      this.#finish(active, exitCode);
    });

    this.#sessions.set(sessionId, active);
    this.#watchOutbox(active);
    return session;
  }

  /** Classify and emit the terminal lifecycle event, then close the stream. */
  #finish(active: ActiveSession, rawExitCode: number | undefined): void {
    // onExit can re-fire once we destroy the underlying socket below; ignore
    // any repeat invocation for an already-torn-down session.
    if (!this.#sessions.has(active.session.id)) return;
    if (active.watcher !== undefined) clearInterval(active.watcher);
    const exitCode = rawExitCode ?? active.signal ?? 1;
    const event: HarnessEvent =
      active.intentionalStop || exitCode === 0
        ? { type: "exit", exitCode }
        : { type: "crash", exitCode };
    active.session.exitCode = exitCode;
    active.session.endedAt = Date.now();
    active.session.status = active.intentionalStop
      ? "terminated"
      : exitCode === 0
        ? "completed"
        : "crashed";
    active.queue.push(event);
    // Close queue synchronously — PTY process has already exited (onExit fired).
    active.queue.close();
    // Release the winpty backend resources (sockets + conout worker) that
    // node-pty leaves alive after kill(), then close the sideband.
    try { active.pty.kill(); } catch { /* ignore */ }
    this.#destroyAgentResources(active.pty);
    void active.session.sideband.dispose().catch(() => undefined);
    this.#sessions.delete(active.session.id);
    this.#endedQueues.set(active.session.id, active.queue);
  }

  /** Release node-pty's private Windows backend resources after kill(). */
  #destroyAgentResources(pty: IPty): void {
    if (process.platform !== "win32") return;
    try {
      const agent = readField(pty, "_agent");
      if (typeof agent !== "object" || agent === null) return;
      // WindowsTerminal#kill() defers to the native agent's kill() until the
      // pty has emitted its first 'data' event (WindowsTerminal#_isReady /
      // #_deferNoArgs). If the session never became ready — killed
      // immediately, or the child produced no output before dying — the
      // pty.kill() call made before this one only *queued* the real kill; it
      // never ran. That leaves the actual child process, the winpty console
      // host, and any process holding a handle in the working directory
      // alive (see microsoft/node-pty#333). WindowsPtyAgent#kill() itself is
      // not deferred, so call it directly as a fallback.
      if (readField(pty, "_isReady") === false) {
        const agentKill = readField(agent, "kill");
        if (typeof agentKill === "function") {
          try { agentKill.call(agent); } catch { /* already torn down */ }
        }
      }
      destroySocket(readField(agent, "_inSocket"));
      destroySocket(readField(agent, "_outSocket"));
      terminateConoutWorker(readField(agent, "_conoutSocketWorker"));
    } catch {
      // Ignore — best effort; resources will release on process exit.
    }
  }

  /** Poll the outbox and surface structured envelopes as events. */
  #watchOutbox(active: ActiveSession): void {
    active.watcher = setInterval(() => {
      void active.session.sideband.readOutbox()
        .then((envelopes) => {
          for (const envelope of envelopes) {
            active.queue.push({ type: "structured", payload: envelope });
          }
        })
        .catch(() => {
          // Session teardown may remove the sideband directory concurrently.
        });
    }, this.#pollIntervalMs);
    active.watcher.unref();
  }

  async send(sessionId: string, input: string): Promise<void> {
    const active = this.#sessions.get(sessionId);
    if (!active) throw new Error(`No active session: ${sessionId}`);
    if (active.session.status !== "running" && active.session.status !== "spawning") {
      throw new Error(`Session ${sessionId} is ${active.session.status}`);
    }
    active.pty.write(input);
  }

  async resize(sessionId: string, cols: number, rows: number): Promise<void> {
    const active = this.#sessions.get(sessionId);
    if (!active) throw new Error(`No active session: ${sessionId}`);
    active.pty.resize(Math.max(cols, 1), Math.max(rows, 1));
    active.session.cols = cols;
    active.session.rows = rows;
  }

  async interrupt(sessionId: string): Promise<void> {
    const active = this.#sessions.get(sessionId);
    if (!active) throw new Error(`No active session: ${sessionId}`);
    if (process.platform === "win32") {
      // ConPTY does not support signal delivery; Ctrl+C is the safe equivalent.
      active.pty.write("\x03");
    } else {
      active.pty.kill("SIGINT");
    }
  }

  async terminate(sessionId: string): Promise<void> {
    const active = this.#sessions.get(sessionId);
    if (!active) throw new Error(`No active session: ${sessionId}`);
    active.intentionalStop = true;
    if (process.platform === "win32") {
      active.pty.kill();
    } else {
      active.pty.kill("SIGTERM");
    }
  }

  async kill(sessionId: string): Promise<void> {
    const active = this.#sessions.get(sessionId);
    if (!active) throw new Error(`No active session: ${sessionId}`);
    active.intentionalStop = true;
    active.pty.kill();
  }

  events(sessionId: string): AsyncIterable<HarnessEvent> {
    const active = this.#sessions.get(sessionId);
    if (active) return active.queue;
    // If #finish already ran, the queue is closed but still readable.
    const ended = this.#endedQueues.get(sessionId);
    if (ended) return ended;
    throw new Error(`No active session: ${sessionId}`);
  }

  /** Write a structured envelope into the session's inbox. */
  async writeInbox(
    sessionId: string,
    payload: unknown,
    opts?: { kind?: string; contextRefs?: ContextReference[]; replyTo?: string },
  ): Promise<string> {
    const active = this.#sessions.get(sessionId);
    if (!active) throw new Error(`No active session: ${sessionId}`);
    return active.session.sideband.writeInbox(payload, opts);
  }

  /** Write context references into the session's inbox. */
  async writeContextRefs(sessionId: string, contextRefs: ContextReference[]): Promise<string> {
    const active = this.#sessions.get(sessionId);
    if (!active) throw new Error(`No active session: ${sessionId}`);
    return active.session.sideband.writeContextRefs(contextRefs);
  }

  /** Drain the session's outbox. */
  async readOutbox(sessionId: string): Promise<SidebandEnvelope[]> {
    const active = this.#sessions.get(sessionId);
    if (!active) throw new Error(`No active session: ${sessionId}`);
    return active.session.sideband.readOutbox();
  }

  /** Remove a session from the registry (does not touch the PTY). */
  async forget(sessionId: string): Promise<void> {
    this.#sessions.delete(sessionId);
  }

  /** Release every owned session: terminate PTYs, dispose sidebands, clear the registry. */
  async close(): Promise<void> {
    const actives = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.allSettled(
      actives.map(async (active) => {
        clearInterval(active.watcher);
        active.intentionalStop = true;
        try { active.pty.kill(); } catch { /* ignore */ }
        this.#destroyAgentResources(active.pty);
        active.session.status = "terminated";
        active.session.endedAt = Date.now();
        active.queue.push({ type: "exit", exitCode: active.session.exitCode ?? 0 });
        try { active.queue.close(); } catch { /* ignore */ }
        this.#endedQueues.set(active.session.id, active.queue);
        try { await active.session.sideband.dispose(); } catch { /* ignore */ }
      }),
    );
    this.#endedQueues.clear();
  }
}
