/**
 * Chef P0 — MCP Client Adapters (Phase 8)
 *
 * Capability integration only — NEVER orchestration protocol.
 *
 * `mcpServers` config comes from workspace settings (env `CHEF_MCP_SERVERS`
 * as JSON for now). Each server = a capability provider (filesystem, browser,
 * git, github, ...). Tool calls are validated against the permission policy
 * before proxying to the server.
 *
 * No SDK dependency: clients speak the MCP JSON-RPC protocol over stdio
 * directly. A server that cannot be spawned or is not listed in the config
 * fails loudly — no fake providers.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { delimiter } from "node:path";
import type { Capability } from "./capabilities.ts";
import type { PermissionMode } from "./capabilities.ts";
import type { CapabilityContext, CapabilityPolicy, capabilityRegistry } from "./capabilities.ts";

export interface McpServerConfig {
  /** Human-readable name (also used as capability provider id). */
  name: string;
  /** Capability this server provides (filesystem, browser, git, github, ...). */
  capability: Capability;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/** Parse `CHEF_MCP_SERVERS` env JSON: array of McpServerConfig. */
export function parseMcpServersConfig(raw: string | undefined): McpServerConfig[] {
  if (!raw || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`CHEF_MCP_SERVERS is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("CHEF_MCP_SERVERS must be a JSON array of server configs");
  }
  return parsed.filter((entry): entry is McpServerConfig => {
    if (typeof entry !== "object" || entry === null) return false;
    const candidate = entry as Record<string, unknown>;
    return (
      typeof candidate.name === "string" &&
      typeof candidate.command === "string" &&
      typeof candidate.capability === "string"
    );
  });
}

/** JSON-RPC 2.0 message envelope. */
interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Locate a binary on PATH (absolute path passthrough). */
export function findOnPath(command: string): string {
  if (command.includes("/")) return command;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = `${dir}/${command}`;
    try {
      // Access check without importing fs/promises at module top-level.
      requireAccessSync(candidate);
      return candidate;
    } catch {
      // keep walking
    }
  }
  return command;
}

function requireAccessSync(path: string): void {
  const { accessSync } = require("node:fs") as typeof import("node:fs");
  accessSync(path);
}

/** Error thrown when an MCP server is unavailable (not configured, missing binary). */
export class McpServerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpServerUnavailableError";
  }
}

/**
 * One live MCP client: a stdio child process speaking JSON-RPC 2.0.
 * Requests are correlated by id; responses stream back.
 */
export class McpClient {
  readonly name: string;
  readonly capability: Capability;
  readonly #config: McpServerConfig;
  #child: ChildProcessWithoutNullStreams | null = null;
  #nextId = 1;
  readonly #pending = new Map<string, { resolve: (result: unknown) => void; reject: (error: Error) => void }>();
  #closed = false;

  constructor(config: McpServerConfig) {
    this.name = config.name;
    this.capability = config.capability;
    this.#config = config;
  }

  /** Spawn the server process and wait for its initialize response. */
  async connect(): Promise<void> {
    if (this.#child) return;
    const binary = findOnPath(this.#config.command);
    const child = spawn(binary, this.#config.args ?? [], {
      cwd: this.#config.cwd,
      env: { ...process.env, ...this.#config.env },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    this.#child = child;

    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line) as JsonRpcMessage;
          this.#handleMessage(message);
        } catch {
          // non-JSON line — protocol violation; fail loudly via pending requests
          this.#rejectAll(new McpServerUnavailableError(`MCP server ${this.name}: non-JSON stdout line`));
        }
      }
    });
    child.stderr.on("data", () => {
      // stderr is diagnostic only; surfaced on request failure.
    });
    child.on("error", (error) => {
      this.#rejectAll(new McpServerUnavailableError(`MCP server ${this.name}: spawn failed: ${error.message}`));
    });
    child.on("close", () => {
      this.#rejectAll(new McpServerUnavailableError(`MCP server ${this.name}: process exited`));
      this.#child = null;
    });

    // MCP handshake: initialize then initialized/notifications.
    const initialize = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "chef", version: "0.1.0" },
    });
    if (!initialize || typeof initialize !== "object" || (initialize as { serverInfo?: unknown }).serverInfo === undefined) {
      this.#rejectAll(new McpServerUnavailableError(`MCP server ${this.name}: initialize response missing serverInfo`));
    }
    this.notify("notifications/initialized", {});
  }

  #handleMessage(message: JsonRpcMessage): void {
    if (message.id === undefined) return; // server→client notification
    const key = String(message.id);
    const pending = this.#pending.get(key);
    if (!pending) return;
    this.#pending.delete(key);
    if (message.error) {
      pending.reject(new Error(`MCP server ${this.name}: ${message.error.message}`));
    } else {
      pending.resolve(message.result);
    }
  }

  #rejectAll(error: Error): void {
    for (const [, pending] of this.#pending) {
      pending.reject(error);
    }
    this.#pending.clear();
  }

  /** Send a JSON-RPC request and await the correlated response. */
  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.#child || this.#closed) {
      return Promise.reject(new McpServerUnavailableError(`MCP server ${this.name}: not connected`));
    }
    const id = this.#nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    this.#pending.set(String(id), { resolve, reject });
    const message: JsonRpcMessage = { jsonrpc: "2.0", id, method, params };
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
    return promise;
  }

  /** Send a fire-and-forget notification. */
  notify(method: string, params: Record<string, unknown>): void {
    if (!this.#child || this.#closed) return;
    const message: JsonRpcMessage = { jsonrpc: "2.0", method, params };
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /** List tools exposed by this server (MCP tools/list). */
  async listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
    const result = (await this.request("tools/list", {})) as { tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> };
    return result?.tools ?? [];
  }

  /** Call a tool on this server with permission-policy validation. */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    checkPermission: (capability: Capability) => PermissionMode,
  ): Promise<unknown> {
    const mode = checkPermission(this.capability);
    if (mode === "deny") {
      throw new Error(`permission denied: capability '${this.capability}' not allowed`);
    }
    if (mode === "approval") {
      throw new Error(`capability '${this.capability}' requires human approval — not auto-approved`);
    }
    const result = (await this.request("tools/call", { name, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    if (result?.isError) {
      throw new Error(`MCP tool ${name}: server reported error`);
    }
    return result?.content ?? [];
  }

  /** Close the child process (SIGTERM, then SIGKILL after 1s). */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const child = this.#child;
    if (!child) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      resolve();
    }, 1000);
    child.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
    await promise;
  }
}

/** Registry of MCP clients, one per configured server. */
export class McpRegistry {
  readonly #clients = new Map<string, McpClient>();

  constructor(configs: McpServerConfig[] = parseMcpServersConfig(process.env.CHEF_MCP_SERVERS)) {
    for (const config of configs) {
      this.#clients.set(config.name, new McpClient(config));
    }
  }

  get(name: string): McpClient | undefined {
    return this.#clients.get(name);
  }

  values(): Iterable<McpClient> {
    return this.#clients.values();
  }

  /** Connect every configured client. Failures are per-server and loud. */
  async connectAll(): Promise<Array<{ name: string; ok: boolean; error?: string }>> {
    const results: Array<{ name: string; ok: boolean; error?: string }> = [];
    for (const client of this.#clients.values()) {
      try {
        await client.connect();
        results.push({ name: client.name, ok: true });
      } catch (error) {
        results.push({
          name: client.name,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results;
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.#clients.values()].map((client) => client.close()));
  }
}

// Re-export types for consumers.
export type { CapabilityContext, CapabilityPolicy };
export { capabilityRegistry } from "./capabilities.ts";
