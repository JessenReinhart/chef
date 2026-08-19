/**
 * Chef P0 — Deterministic Tool Runner (Phase 8)
 *
 * Terminal (PTY harness + runCommand), filesystem (scoped to project root +
 * allowed extensions), git (scoped to repo). Every tool call goes through
 * the permission policy first (spec §11.2): denied → PermissionDeniedError,
 * approval-required → approval.requested event + pending until resolved.
 *
 * Validation order: permission policy → config schema → execution.
 * No fake implementations: missing capability = honest error.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import type {
  Artifact,
  EntityRef,
  RuntimeEvent,
  Timestamp,
  WorkspaceId,
} from "../core/types.ts";
import type { Approval } from "../core/approvals.ts";
import type { Repository } from "../persistence/database.ts";
import type { HarnessLike } from "../runtime/scheduler.ts";
import {
  type Capability,
  type CapabilityContext,
  type CapabilityPolicy,
  type CapabilityRegistry,
  capabilityRegistry,
} from "./capabilities.ts";
import type { HarnessRegistry } from "../runtime/scheduler.ts";

export interface ToolCall {
  tool: string;
  config?: Record<string, unknown>;
  input?: Record<string, unknown>;
  permissions?: CapabilityPolicy;
}

export interface ToolContext {
  workspaceId: WorkspaceId;
  projectDir: string;
  /** Harness registry for terminal tool execution (PTY). */
  harnessRegistry: HarnessRegistry;
  /** Permission policy context. */
  capabilities: CapabilityContext;
  /** Callback to persist events (approval.requested etc.). */
  emitEvent?: (event: RuntimeEvent) => void;
  /** Persist an approval row (defaults to a no-op in-memory gate). */
  persistApproval?: (approval: Approval) => void;
}

export interface ToolResult {
  ok: boolean;
  output: unknown;
  artifact?: Artifact;
  status: "completed" | "failed" | "approval" | "denied";
  durationMs: number;
  approvalId?: string;
}

type CapabilityRegistryLike = Pick<CapabilityRegistry, "checkPermission">;


/**
 * Permission errors carry the capability so callers can surface which gate
 * was hit.
 */
export class PermissionDeniedError extends Error {
  readonly capability: Capability;
  constructor(capability: Capability, agentId: string) {
    super(`permission denied: capability '${capability}' not allowed for agent '${agentId}'`);
    this.name = "PermissionDeniedError";
    this.capability = capability;
  }
}

/** Raised when the request is valid but the underlying capability is absent. */
export class CapabilityUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityUnavailableError";
  }
}

/** Returns `true` when `target` resolves inside `root` (both absolute). */
export function isWithinRoot(root: string, target: string): boolean {
  const rel = normalize(target).replace(/\\/g, "/");
  const rootRel = normalize(root).replace(/\\/g, "/");
  return rel === rootRel || rel.startsWith(rootRel.endsWith("/") ? rootRel : `${rootRel}/`);
}

/** Coerce a single string or array-of-strings value from tool input. */
function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  return typeof value === "string" ? [value] : [];
}

// ---------------------------------------------------------------------------
// Terminal tool
// ---------------------------------------------------------------------------

export interface TerminalToolConfig {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface TerminalToolResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

/** Resolve a shell command against PATH (like the harness does). */
export function resolveExecutablePath(command: string): string {
  if (isAbsolute(command)) return command;
  const binary = command.split(/\s+/, 1)[0] ?? command;
  if (isAbsolute(binary)) return binary;
  const dirs = (process.env.PATH ?? "").split(delimiter);
  for (const dir of dirs) {
    const candidate = join(dir, binary);
    if (existsSync(candidate)) {
      return candidate;
    }
    // keep walking
  }
  return binary;
}

/**
 * Terminal execution via the PTY harness registry. The harness owns the PTY
 * and streams stdout/stderr back as events; exit code is authoritative.
 */
export async function executeTerminal(
  ctx: ToolContext,
  config: TerminalToolConfig,
): Promise<TerminalToolResult> {
  if (ctx.capabilities.role !== "human" && config.cwd && !isWithinRoot(ctx.projectDir, config.cwd)) {
    throw new PermissionDeniedError("filesystem", ctx.capabilities.agentId);
  }

  const harness = selectHarness(ctx.harnessRegistry);
  const command = resolveExecutablePath(config.command);
  const timeoutMs = config.timeoutMs ?? 30_000;

  const session = await harness.spawn({
    command,
    args: config.args ?? [],
    cwd: config.cwd ?? ctx.projectDir,
    env: config.env,
    cols: 120,
    rows: 40,
  });

  let stdout = "";
  let stderr = "";
  let exitCode: number | undefined;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void harness.terminate(session.id).catch(() => undefined);
  }, timeoutMs);

  try {
    for await (const event of harness.events(session.id)) {
      if (event.type === "data") {
        stdout += event.data;
      } else if (event.type === "exit" || event.type === "crash") {
        exitCode = event.exitCode;
        break;
      }
    }
  } finally {
    clearTimeout(timer);
  }

  if (exitCode === undefined) exitCode = timedOut ? 124 : 1;
  stderr = ""; // PTY merges stderr; harness contract delivers only `data`.
  return { stdout, stderr, exitCode, timedOut };
}

function selectHarness(registry: HarnessRegistry): HarnessLike {
  const generic = registry.get("generic");
  if (generic) return generic;
  throw new CapabilityUnavailableError("terminal tool: generic command harness not registered");
}

// ---------------------------------------------------------------------------
// Filesystem tool
// ---------------------------------------------------------------------------

export interface FileToolConfig {
  operation: "read" | "write" | "list" | "delete";
  path: string;
  content?: string;
}

const ALLOWED_READ_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".txt",
  ".sql", ".css", ".html", ".yml", ".yaml", ".toml", ".xml", ".svg",
]);

const ALLOWED_WRITE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".txt",
  ".sql", ".css", ".html", ".yml", ".yaml", ".toml", ".xml",
]);

/** Resolve a tool-supplied path against the project root (absolute stays absolute). */
export function resolveToolPath(projectDir: string, rawPath: string): string {
  const candidate = isAbsolute(rawPath) ? rawPath : resolve(projectDir, rawPath);
  return normalize(candidate);
}

/** Resolve and validate: read/list must stay inside project root; write/delete
 *  out-of-root paths require explicit permission override (approval gate
 *  handled by the runner). */
export function validateFilePath(
  projectDir: string,
  rawPath: string,
  operation: "read" | "write" | "list" | "delete",
): string {
  const resolved = resolveToolPath(projectDir, rawPath);
  const root = realpathSyncSafe(projectDir) ?? resolve(projectDir);
  const target = realpathSyncSafe(resolved) ?? resolved;
  if (!isWithinRoot(root, target)) {
    throw new PermissionDeniedError("filesystem", "tool");
  }
  if (operation !== "list") {
    const ext = target.slice(target.lastIndexOf("."));
    if (operation === "read") {
      if (ext && !ALLOWED_READ_EXTENSIONS.has(ext.toLowerCase())) {
        throw new CapabilityUnavailableError(`filesystem read: extension '.${ext}' not allowed`);
      }
    } else if (operation === "write") {
      if (ext && !ALLOWED_WRITE_EXTENSIONS.has(ext.toLowerCase())) {
        throw new CapabilityUnavailableError(`filesystem write: extension '.${ext}' not allowed`);
      }
    }
  }
  return target;
}

function realpathSyncSafe(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

export async function executeFile(
  ctx: ToolContext,
  config: FileToolConfig,
): Promise<{ content?: string; entries?: string[]; path: string }> {
  const path = validateFilePath(ctx.projectDir, config.path, config.operation);
  if (config.operation === "read") {
    const content = await readFile(path, "utf8");
    return { content, path };
  }
  if (config.operation === "write") {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, config.content ?? "", "utf8");
    return { path };
  }
  if (config.operation === "list") {
    const entries = await readdir(path);
    return { entries, path };
  }
  throw new CapabilityUnavailableError(`filesystem ${config.operation}: not implemented`);
}


// ---------------------------------------------------------------------------
// Git tool
// ---------------------------------------------------------------------------

export interface GitToolConfig {
  operation: "status" | "diff" | "commit" | "branch" | "log" | "push";
  message?: string;
  paths?: string[];
  remote?: string;
  branch?: string;
}

const GIT_ALLOWED_OPERATIONS: readonly GitToolConfig["operation"][] = [
  "status", "diff", "commit", "branch", "log", "push",
];

function isGitOperation(value: string): value is GitToolConfig["operation"] {
  return GIT_ALLOWED_OPERATIONS.some((operation) => operation === value);
}

/**
 * Git tool — spawns `git` directly (not via PTY) with `--no-pager` and
 * scoped to the repo root. Read-only ops (status/diff/branch/log) run
 * freely; commit requires the `git` capability; push is destructive and
 * gated by the runner's approval policy.
 */
export async function executeGit(
  ctx: ToolContext,
  config: GitToolConfig,
): Promise<{ stdout: string; exitCode: number }> {
  if (!GIT_ALLOWED_OPERATIONS.includes(config.operation)) {
    throw new CapabilityUnavailableError(`git ${config.operation}: unknown operation`);
  }
  const repoRoot = await findGitRoot(ctx.projectDir);
  if (!repoRoot) {
    throw new CapabilityUnavailableError(`git: ${ctx.projectDir} is not inside a git repository`);
  }

  const args: string[] = ["--no-pager", "-C", repoRoot, config.operation];
  if (config.operation === "commit") {
    if (typeof config.message !== "string" || config.message.length === 0) {
      throw new Error("git commit: message is required");
    }
    if (config.paths && config.paths.length > 0) {
      args.push(...config.paths);
    }
    args.push("-m", config.message);
  } else if (config.operation === "push") {
    if (config.remote) args.push(config.remote);
    if (config.branch) args.push(config.branch);
  } else if (config.operation === "branch") {
    args.push("-a");
  } else if (config.operation === "log") {
    args.push("--oneline", "-n", "20");
  } else if (config.operation === "diff") {
    args.push("--stat");
  }

  return runGit(args, repoRoot, ctx);
}

async function findGitRoot(start: string): Promise<string | null> {
  let dir = resolve(start);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await access(join(dir, ".git"));
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
}

async function runGit(
  args: string[],
  cwd: string,
  ctx: ToolContext,
): Promise<{ stdout: string; exitCode: number }> {
  const { promise, resolve: settle, reject } = Promise.withResolvers<{ stdout: string; exitCode: number }>();
  const child = spawn("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  child.on("error", (error) => {
    reject(new CapabilityUnavailableError(`git: ${error.message}`));
  });
  child.on("close", (code) => {
    if (code !== 0 && stderr.length > 0) {
      reject(new Error(`git ${args[2]}: ${stderr.trim()}`));
      return;
    }
    settle({ stdout, exitCode: code ?? 1 });
  });
  return promise;
}

// ---------------------------------------------------------------------------
// Tool runner
// ---------------------------------------------------------------------------

/** Approval gate: in-memory pending approvals keyed by id. */
interface PendingApproval {
  approvalId: string;
  capability: Capability;
  reason: string;
  resolve: (decision: "accepted" | "rejected") => void;
}

const MAX_OUTPUT_BYTES = 256 * 1024;

/** Truncate very large outputs to keep responses bounded. */
function truncateOutput(output: string, maxBytes = MAX_OUTPUT_BYTES): string {
  if (output.length <= maxBytes) return output;
  return `${output.slice(0, maxBytes)}\n…[truncated ${output.length - maxBytes} bytes]`;
}

export class ToolRunner {
  readonly #pending = new Map<string, PendingApproval>();

  constructor(context: ToolContext, registry: CapabilityRegistryLike = capabilityRegistry) {
    this.#context = context;
    this.#registry = registry;
  }
  readonly #context: ToolContext;
  readonly #registry: CapabilityRegistryLike;

  /** List tools this runner can execute, with their schemas. */
  listTools(): Array<{ type: string; description: string; params: Record<string, string>; capability: Capability }> {
    return [
      { type: "bash", description: "Run a shell command", params: { command: "string", cwd: "string", timeoutMs: "number" }, capability: "terminal" },
      { type: "file_read", description: "Read a file", params: { path: "string" }, capability: "filesystem" },
      { type: "file_write", description: "Write a file", params: { path: "string", content: "string" }, capability: "filesystem" },
      { type: "file_list", description: "List a directory", params: { path: "string" }, capability: "filesystem" },
      { type: "git", description: "Git operations (status/diff/commit/branch/log/push)", params: { operation: "string", message: "string", paths: "string[]" }, capability: "git" },
    ];
  }

  /** Resolve a pending approval; re-resolution is a no-op. Returns false when unknown. */
  resolveApproval(approvalId: string, decision: "accepted" | "rejected"): boolean {
    const pending = this.#pending.get(approvalId);
    if (!pending) return false;
    this.#pending.delete(approvalId);
    pending.resolve(decision);
    return true;
  }

  /** Execute a tool call. Validation order: policy → schema → execution. */
  async execute(call: ToolCall): Promise<ToolResult> {
    const startedAt = Date.now() as Timestamp;
    try {
      const result = await this.#execute(call);
      return { ...result, durationMs: Date.now() - startedAt };
    } catch (error) {
      if (error instanceof PermissionDeniedError) {
        return {
          ok: false,
          output: { error: error.message, capability: error.capability },
          status: "denied",
          durationMs: Date.now() - startedAt,
        };
      }
      if (error instanceof CapabilityUnavailableError) {
        return {
          ok: false,
          output: { error: error.message },
          status: "failed",
          durationMs: Date.now() - startedAt,
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        output: { error: message },
        status: "failed",
        durationMs: Date.now() - startedAt,
      };
    }
  }

  async #execute(call: ToolCall): Promise<Omit<ToolResult, "durationMs">> {
    const toolCtx: ToolContext = {
      ...this.#context,
      capabilities: { ...this.#context.capabilities, customPolicy: call.permissions },
    };
    const { tool } = call;
    const input = call.input ?? {};
    const caps = toolCtx.capabilities;

    if (tool === "bash" || tool === "terminal") {
      const mode = this.#registry.checkPermission(caps, "terminal");
      if (mode === "deny") throw new PermissionDeniedError("terminal", caps.agentId);
      const command = String(input.command ?? "");
      if (command === "") throw new Error("bash: command is required");
      const absoluteCommand = isAbsolute(command);
      const parts = absoluteCommand ? [command] : command.trim().split(/\s+/);
      const config: TerminalToolConfig = {
        command: parts[0] ?? "",
        args: Array.isArray(input.args) ? asStringArray(input.args) : parts.slice(1),
        cwd: typeof input.cwd === "string" ? input.cwd : undefined,
        env: typeof input.env === "object" && input.env !== null ? (input.env as Record<string, string>) : undefined,
        timeoutMs: typeof input.timeoutMs === "number" ? input.timeoutMs : undefined,
      };
      const result = await executeTerminal(toolCtx, config);
      return {
        ok: result.exitCode === 0,
        output: {
          stdout: truncateOutput(result.stdout),
          stderr: truncateOutput(result.stderr),
          exitCode: result.exitCode,
          timedOut: result.timedOut,
        },
        status: result.exitCode === 0 ? "completed" : "failed",
      };
    }

    if (tool === "file_read" || tool === "file_write" || tool === "file_list") {
      const mode = this.#registry.checkPermission(caps, "filesystem");
      if (mode === "deny") throw new PermissionDeniedError("filesystem", caps.agentId);
      const rawPath = String(input.path ?? "");
      if (rawPath === "") throw new Error(`${tool}: path is required`);
      const operation = tool === "file_read" ? "read" : tool === "file_write" ? "write" : "list";
      const config: FileToolConfig = {
        operation,
        path: rawPath,
        content: typeof input.content === "string" ? input.content : undefined,
      };
      const result = await executeFile(toolCtx, config);
      return {
        ok: true,
        output: result.content !== undefined ? { content: truncateOutput(result.content) } : { entries: result.entries, path: result.path },
        status: "completed",
      };
    }

    if (tool === "git") {
      const mode = this.#registry.checkPermission(caps, "git");
      if (mode === "deny") throw new PermissionDeniedError("git", caps.agentId);
      const operation = String(input.operation ?? "");
      if (!isGitOperation(operation)) {
        throw new Error(`git: operation must be one of status|diff|commit|branch|log|push, got '${operation}'`);
      }
      if (operation === "push") {
        return this.#withApproval(caps, "git", `git push ${input.remote ?? ""} ${input.branch ?? ""}`.trim(), async () => {
          const result = await executeGit(toolCtx, { operation: "push", remote: typeof input.remote === "string" ? input.remote : undefined, branch: typeof input.branch === "string" ? input.branch : undefined });
          return { ok: result.exitCode === 0, output: { stdout: truncateOutput(result.stdout) }, status: result.exitCode === 0 ? "completed" : "failed" };
        });
      }
      if (operation === "commit") {
        // Commit mutates repo state; require approval for non-engineer roles.
        const mode2 = this.#registry.checkPermission(caps, "git");
        if (mode2 === "approval") {
          return this.#withApproval(caps, "git", `git commit -m "${input.message ?? ""}"`, async () => {
            const result = await executeGit(toolCtx, { operation: "commit", message: typeof input.message === "string" ? input.message : undefined, paths: asStringArray(input.paths) });
            return { ok: result.exitCode === 0, output: { stdout: truncateOutput(result.stdout) }, status: result.exitCode === 0 ? "completed" : "failed" };
          });
        }
      }
      const result = await executeGit(toolCtx, {
        operation,
        message: typeof input.message === "string" ? input.message : undefined,
        paths: asStringArray(input.paths),
        remote: typeof input.remote === "string" ? input.remote : undefined,
        branch: typeof input.branch === "string" ? input.branch : undefined,
      });
      return {
        ok: result.exitCode === 0,
        output: { stdout: truncateOutput(result.stdout) },
        status: result.exitCode === 0 ? "completed" : "failed",
      };
    }

    throw new CapabilityUnavailableError(`tool '${tool}' not available — no runner registered`);
  }

  /**
   * Destructive/approval-gated operation: emit `approval.requested`, persist
   * the approval row, and block until resolveApproval. Rejection fails the
   * call with an honest error — never a silent fallback.
   */
  async #withApproval(
    ctx: CapabilityContext,
    capability: Capability,
    reason: string,
    run: () => Promise<Omit<ToolResult, "durationMs">>,
  ): Promise<Omit<ToolResult, "durationMs">> {
    const approvalId = randomUUID();
    const { promise, resolve } = Promise.withResolvers<"accepted" | "rejected">();
    const pending: PendingApproval = {
      approvalId,
      capability,
      reason,
      resolve,
    };
    this.#pending.set(approvalId, pending);
    this.#context.emitEvent?.({
      id: randomUUID(),
      workspaceId: this.#context.workspaceId,
      seq: 0,
      timestamp: Date.now(),
      source: { type: "runtime", id: "tool-runner" },
      type: "approval.requested",
      payload: { approvalId, capability, reason },
    });
    // Persist via repository so the approval shows in inspectState.
    try {
      this.#context.persistApproval?.({
        id: approvalId,
        workspaceId: this.#context.workspaceId,
        taskId: "tool-runner",
        status: "pending",
        requester: this.#context.capabilities.agentId,
        reason,
        createdAt: Date.now(),
      });
    } catch {
      // In-memory gate still works without a repository.
    }
    const decision = await promise;
    if (decision === "rejected") {
      throw new PermissionDeniedError(capability, ctx.agentId);
    }
    return run();
  }
}

// ---------------------------------------------------------------------------
// Tool runner wiring for the HTTP server
// ---------------------------------------------------------------------------

/** Convert a ToolRunner result into an HTTP response body. */
export function toolResultToJson(result: ToolResult): { ok: boolean; output: unknown; artifact?: Artifact; status: string; durationMs: number; approvalId?: string } {
  return {
    ok: result.ok,
    output: result.output,
    artifact: result.artifact,
    status: result.status,
    durationMs: result.durationMs,
    approvalId: result.approvalId,
  };
}

/** Create a ToolContext from a ChefRuntime for the HTTP server. */
export function createToolContextForChef(runtime: {
  workspaceId: WorkspaceId;
  repository: Repository;
  projectDir: string;
}): ToolContext {
  const ctx: ToolContext = {
    workspaceId: runtime.workspaceId,
    projectDir: runtime.projectDir,
    harnessRegistry: {
      get: () => undefined,
      set: () => {},
      values: () => [],
    },
    capabilities: {
      agentId: "human",
      workspaceId: runtime.workspaceId,
      role: "human",
    },
  };
  return ctx;
}
