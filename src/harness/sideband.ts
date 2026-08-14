import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Sideband directories carry structured platform communication between a
 * harness process and the runtime, entirely separate from PTY stdout/stderr.
 *
 * Layout:
 *   <root>/<sessionId>/inbox/    — runtime -> process (context refs, tasks)
 *   <root>/<sessionId>/outbox/   — process -> runtime (artifacts, findings)
 *
 * Every file is a JSON envelope. The runtime never routes these bytes through
 * the PTY, so terminal output stays pure.
 */

export interface SidebandEnvelope {
  /** Envelope schema version. */
  version: 1;
  /** Unique envelope id. */
  id: string;
  /** Envelope kind — e.g. "context", "artifact", "message", "result". */
  kind: string;
  /** Origin: "runtime" for inbox, "process" for outbox. */
  from: string;
  /** Structured payload. */
  payload: unknown;
  /** Optional reply-to envelope id. */
  replyTo?: string;
  /** Optional context references carried by this envelope. */
  contextRefs?: ContextReference[];
  /** Epoch millis when the envelope was written. */
  timestamp: number;
}

export interface ContextReference {
  type: "artifact" | "event" | "message" | "task" | "decision" | "file";
  id: string;
  relevance?: number;
}

/** Default sideband root, DB-agnostic and shared across harness instances. */
export function defaultSidebandRoot(): string {
  return join(tmpdir(), "chef-sideband");
}

/**
 * Filesystem-backed sideband directory for a single session.
 *
 * The process reads `inbox`, the runtime reads `outbox`. Both are plain JSON
 * files written atomically (temp file + rename) so a concurrent reader never
 * sees a half-written envelope.
 */
export class SidebandDirectory {
  readonly sessionId: string;
  readonly root: string;
  readonly inbox: string;
  readonly outbox: string;

  constructor(sessionId: string, root: string = defaultSidebandRoot()) {
    this.sessionId = sessionId;
    this.root = join(root, sessionId);
    this.inbox = join(this.root, "inbox");
    this.outbox = join(this.root, "outbox");
  }

  /** Create inbox/outbox directories (idempotent). */
  async init(): Promise<void> {
    await mkdir(this.inbox, { recursive: true });
    await mkdir(this.outbox, { recursive: true });
  }

  /**
   * Write a context/instruction envelope into the inbox for the process to
   * consume. `contextRefs` are written verbatim so a harness adapter can
   * translate them into its own injection mechanism.
   */
  async writeInbox(payload: unknown, opts?: {
    kind?: string;
    contextRefs?: ContextReference[];
    replyTo?: string;
    from?: string;
  }): Promise<string> {
    await this.init();
    const envelope: SidebandEnvelope = {
      version: 1,
      id: randomUUID(),
      kind: opts?.kind ?? "context",
      from: opts?.from ?? "runtime",
      payload,
      replyTo: opts?.replyTo,
      contextRefs: opts?.contextRefs,
      timestamp: Date.now(),
    };
    await this.#writeEnvelope(this.inbox, envelope);
    return envelope.id;
  }

  /** Helper to drop bare context references into the inbox. */
  async writeContextRefs(contextRefs: ContextReference[]): Promise<string> {
    return this.writeInbox({ contextRefs }, { kind: "context", contextRefs });
  }

  /** Read and remove all outbox envelopes (FIFO by filename). */
  async readOutbox(): Promise<SidebandEnvelope[]> {
    await this.init();
    const names = (await readdir(this.outbox)).filter((n) => n.endsWith(".json")).sort();
    const envelopes: SidebandEnvelope[] = [];
    for (const name of names) {
      const path = join(this.outbox, name);
      const raw = await readFile(path, "utf8");
      envelopes.push(JSON.parse(raw) as SidebandEnvelope);
      await rm(path, { force: true });
    }
    return envelopes;
  }

  /** Write a process->runtime envelope into the outbox. */
  async writeOutbox(payload: unknown, opts?: {
    kind?: string;
    replyTo?: string;
  }): Promise<string> {
    await this.init();
    const envelope: SidebandEnvelope = {
      version: 1,
      id: randomUUID(),
      kind: opts?.kind ?? "result",
      from: "process",
      payload,
      replyTo: opts?.replyTo,
      timestamp: Date.now(),
    };
    await this.#writeEnvelope(this.outbox, envelope);
    return envelope.id;
  }

  /** Remove the whole sideband tree for this session. */
  async dispose(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }

  /** Atomic write: temp file in same dir, then rename over final name. */
  async #writeEnvelope(dir: string, envelope: SidebandEnvelope): Promise<void> {
    await mkdir(dir, { recursive: true });
    const final = join(dir, `${envelope.id}.json`);
    const tmp = join(dir, `.${envelope.id}.json.tmp`);
    await writeFile(tmp, JSON.stringify(envelope), "utf8");
    await rename(tmp, final);
  }
}
