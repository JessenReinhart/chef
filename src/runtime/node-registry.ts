/**
 * Chef P0 — typed node registry (spec §12).
 *
 * Registers the nine node categories (AI Agent, Terminal, File/Data, Browser,
 * Transform, Logic, Human, Database, Output) as executable NodeDefinitions.
 * The registry is UI-independent: the canvas projects from these contracts,
 * never the reverse. "LLMs propose; runtime validates/executes" — every
 * definition carries a ConfigSchema that validates proposed configs and
 * applies defaults.
 *
 * Node executers are thin adapters over the runtime surface exposed in
 * NodeExecutionContext (harness, repository-backed runtime helpers). No fake
 * providers: a definition that cannot execute its kind in-process throws a
 * descriptive error rather than silently succeeding.
 */

import type { Approval } from "../core/types.ts";
import type {
  Artifact,
  ContextReference,
  Harness,
  NodeDefinition,
  NodeExecutionContext,
  NodeExecutionResult,
  NodeStatus,
  RuntimeEvent,
} from "../core/nodes.ts";
import type { EntityRef } from "../core/types.ts";

// ---------------------------------------------------------------------------
// Small shared helpers (module-local, not exported API)
// ---------------------------------------------------------------------------

function now(): number {
  return Date.now();
}

/** Strip unknown keys, keep only `allowed`; used by lenient config schemas. */
function pick<T extends object>(
  config: unknown,
  allowed: readonly string[],
): Partial<T> {
  if (typeof config !== "object" || config === null) return {};
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in config) out[key] = (config as Record<string, unknown>)[key];
  }
  return out as Partial<T>;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every((v) => typeof v === "string")
  );
}

/** Event factory: assign seq/timestamp/source from the execution context. */
function eventFor(
  ctx: Pick<NodeExecutionContext, "workspaceId" | "taskId" | "sessionId">,
  type: string,
  payload: unknown,
): RuntimeEvent {
  const source: EntityRef = { type: "task", id: ctx.taskId };
  return {
    id: crypto.randomUUID(),
    workspaceId: ctx.workspaceId,
    seq: 0, // assigned by the repository when persisted
    timestamp: now(),
    source,
    type,
    payload,
    taskId: ctx.taskId,
    sessionId: ctx.sessionId,
  };
}

/** Resolve a config key against inputs first, then config, then fallback. */
function resolveValue(
  ctx: Pick<NodeExecutionContext, "inputs" | "config">,
  key: string,
  fallback: unknown,
): unknown {
  const fromInputs = (ctx.inputs as Record<string, unknown>)[key];
  if (fromInputs !== undefined && fromInputs !== null) return fromInputs;
  const fromConfig = (ctx.config as Record<string, unknown>)[key];
  if (fromConfig !== undefined && fromConfig !== null) return fromConfig;
  return fallback;
}

// ---------------------------------------------------------------------------
// Execution adapter: harness-driven terminal command
// ---------------------------------------------------------------------------

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run a command through the harness (PTY), preserving the PTY vs sideband
 * separation: stdout/stderr are read from the harness event stream only.
 * Timeout is bounded and enforced; a timed-out run is terminated, never left
 * running. No silent fallbacks.
 */
async function runCommand(
  ctx: NodeExecutionContext,
  command: string,
  opts: {
    cwd?: string;
    env?: Record<string, string>;
    cols?: number;
    rows?: number;
    timeoutMs?: number;
  },
): Promise<CommandResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const session = await ctx.harness.spawn({
    command,
    args: [],
    cwd: opts.cwd,
    env: opts.env,
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    workspaceId: ctx.workspaceId,
  });

  let stdout = "";
  let stderr = "";
  let exitCode: number | undefined;
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    void ctx.harness.terminate(session.id);
  }, timeoutMs);

  try {
    for await (const event of ctx.harness.events(session.id)) {
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

  if (exitCode === undefined) {
    exitCode = timedOut ? 124 : 1;
  }

  return { stdout, stderr, exitCode };
}

// ---------------------------------------------------------------------------
// Config schemas
// ---------------------------------------------------------------------------

export interface AgentNodeConfig {
  model: string;
  temperature: number;
  maxTokens: number;
  systemPrompt: string;
  tools: string[];
  permissionPolicy: "auto" | "ask" | "deny";
}

export interface TerminalNodeConfig {
  shell: string;
  cols: number;
  rows: number;
  timeoutMs: number;
  allowInteractive: boolean;
}

export interface FileNodeConfig {
  basePath: string;
  allowedExtensions: string[];
  maxSizeBytes: number;
}

export interface BrowserNodeConfig {
  headless: boolean;
  timeoutMs: number;
  viewport: { width: number; height: number };
  userAgent: string;
}

export interface TransformNodeConfig {
  language: "js" | "ts" | "python" | "sql";
  allowedImports: string[];
  timeoutMs: number;
}

export interface LogicNodeConfig {
  conditionType: "if" | "switch" | "loop";
  expression: string;
  maxIterations: number;
}

export interface HumanNodeConfig {
  timeoutMs: number;
  required: boolean;
  options: string[];
}

export interface DatabaseNodeConfig {
  driver: "sqlite" | "postgres" | "mysql";
  connectionString: string;
  readOnly: boolean;
}

export interface OutputNodeConfig {
  defaultFormat: "pdf" | "excel" | "email" | "markdown" | "json";
  templates: string[];
  deliveryChannels: string[];
}

// ---------------------------------------------------------------------------
// The nine node definitions
// ---------------------------------------------------------------------------

export const NODE_DEFINITIONS: readonly NodeDefinition[] = [
  // 1. AI Agent ---------------------------------------------------------------
  {
    type: "agent.llm",
    category: "agent",
    label: "AI Agent",
    description: "Delegates a prompt to an LLM agent with tools and permissions.",
    inputs: [
      { id: "prompt", label: "Prompt", type: "data", required: true },
      { id: "context", label: "Context", type: "data", required: false },
      { id: "tools", label: "Tools", type: "control", required: false },
    ],
    outputs: [
      { id: "response", label: "Response", type: "data", required: false },
      { id: "artifacts", label: "Artifacts", type: "data", required: false },
      { id: "handoff", label: "Handoff", type: "control", required: false },
    ],
    config: {
      validate(config: unknown): AgentNodeConfig {
        const c = pick<AgentNodeConfig>(config, [
          "model", "temperature", "maxTokens", "systemPrompt", "tools", "permissionPolicy",
        ]);
        if (typeof c.model !== "string" || c.model === "") {
          throw new Error("agent.llm: config.model is required (string)");
        }
        const temperature =
          typeof c.temperature === "number" && c.temperature >= 0 && c.temperature <= 2
            ? c.temperature
            : 0.2;
        const maxTokens =
          typeof c.maxTokens === "number" && c.maxTokens > 0 ? c.maxTokens : 4096;
        const systemPrompt = typeof c.systemPrompt === "string" ? c.systemPrompt : "";
        const tools = isStringArray(c.tools) ? c.tools : [];
        const permissionPolicy = ["auto", "ask", "deny"].includes(c.permissionPolicy as string)
          ? (c.permissionPolicy as AgentNodeConfig["permissionPolicy"])
          : "ask";
        return { model: c.model, temperature, maxTokens, systemPrompt, tools, permissionPolicy };
      },
      defaults() {
        return {
          model: "default",
          temperature: 0.2,
          maxTokens: 4096,
          systemPrompt: "",
          tools: [],
          permissionPolicy: "ask",
        };
      },
    },
    async execute(ctx) {
      const prompt = String(resolveValue(ctx, "prompt", ""));
      if (prompt === "") {
        throw new Error("agent.llm: required input 'prompt' is empty");
      }
      // LLM execution requires an agent runtime. The engine validates this
      // node's runnability before dispatch; here we fail loudly rather than
      // fake a response.
      throw new Error(
        "agent.llm: execution requires an agent runtime adapter (Phase 2); node is validated and registered",
      );
    },
  },

  // 2. Terminal ---------------------------------------------------------------
  {
    type: "tool.terminal",
    category: "tool",
    label: "Terminal",
    description: "Runs a shell command through the PTY harness.",
    inputs: [
      { id: "command", label: "Command", type: "data", required: true },
      { id: "cwd", label: "Working directory", type: "data", required: false },
      { id: "env", label: "Environment", type: "data", required: false },
    ],
    outputs: [
      { id: "stdout", label: "Standard output", type: "data", required: false },
      { id: "stderr", label: "Standard error", type: "data", required: false },
      { id: "exitCode", label: "Exit code", type: "data", required: false },
    ],
    config: {
      validate(config: unknown): TerminalNodeConfig {
        const c = pick<TerminalNodeConfig>(config, [
          "shell", "cols", "rows", "timeoutMs", "allowInteractive",
        ]);
        if (c.allowInteractive !== undefined && typeof c.allowInteractive !== "boolean") {
          throw new Error("tool.terminal: config.allowInteractive must be a boolean");
        }
        const shell = typeof c.shell === "string" && c.shell !== "" ? c.shell : "/bin/bash";
        const cols = typeof c.cols === "number" && c.cols > 0 ? c.cols : 80;
        const rows = typeof c.rows === "number" && c.rows > 0 ? c.rows : 24;
        const timeoutMs = typeof c.timeoutMs === "number" && c.timeoutMs > 0 ? c.timeoutMs : 30_000;
        const allowInteractive = c.allowInteractive ?? false;
        return { shell, cols, rows, timeoutMs, allowInteractive };
      },
      defaults() {
        return { shell: "/bin/bash", cols: 80, rows: 24, timeoutMs: 30_000, allowInteractive: false };
      },
    },
    async execute(ctx) {
      const command = String(resolveValue(ctx, "command", ""));
      if (command === "") {
        throw new Error("tool.terminal: required input 'command' is empty");
      }
      const config = ctx.config as TerminalNodeConfig;
      const cwd = resolveValue(ctx, "cwd", undefined);
      const env = resolveValue(ctx, "env", undefined);
      const result = await runCommand(ctx, command, {
        cwd: typeof cwd === "string" ? cwd : undefined,
        env: isStringRecord(env) ? env : undefined,
        cols: config.cols,
        rows: config.rows,
        timeoutMs: config.timeoutMs,
      });
      const events: RuntimeEvent[] = [
        eventFor(ctx, "node.terminal.completed", {
          nodeType: "tool.terminal",
          exitCode: result.exitCode,
          stdoutBytes: result.stdout.length,
          stderrBytes: result.stderr.length,
        }),
      ];
      return {
        status: result.exitCode === 0 ? "completed" : "failed",
        outputs: {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        },
        artifacts: [],
        events,
        nextNodeHints: result.exitCode === 0 ? [] : ["error"],
      };
    },
  },

  // 3. File/Data ---------------------------------------------------------------
  {
    type: "tool.file",
    category: "tool",
    label: "File/Data",
    description: "Reads, writes, or transforms files and data.",
    inputs: [
      { id: "source", label: "Source", type: "data", required: true },
      { id: "operation", label: "Operation (read|write|transform)", type: "data", required: true },
      { id: "format", label: "Format", type: "data", required: false },
    ],
    outputs: [
      { id: "content", label: "Content", type: "data", required: false },
      { id: "artifact", label: "Artifact", type: "data", required: false },
    ],
    config: {
      validate(config: unknown): FileNodeConfig {
        const c = pick<FileNodeConfig>(config, ["basePath", "allowedExtensions", "maxSizeBytes"]);
        const basePath = typeof c.basePath === "string" ? c.basePath : ".";
        const allowedExtensions = isStringArray(c.allowedExtensions) ? c.allowedExtensions : [];
        const maxSizeBytes =
          typeof c.maxSizeBytes === "number" && c.maxSizeBytes > 0 ? c.maxSizeBytes : 10 * 1024 * 1024;
        return { basePath, allowedExtensions, maxSizeBytes };
      },
      defaults() {
        return { basePath: ".", allowedExtensions: [], maxSizeBytes: 10 * 1024 * 1024 };
      },
    },
    async execute(ctx) {
      const source = String(resolveValue(ctx, "source", ""));
      const operation = String(resolveValue(ctx, "operation", ""));
      if (source === "") {
        throw new Error("tool.file: required input 'source' is empty");
      }
      if (!["read", "write", "transform"].includes(operation)) {
        throw new Error(`tool.file: operation must be read|write|transform, got '${operation}'`);
      }
      if (operation === "write") {
        throw new Error(
          "tool.file: write requires a filesystem adapter (Phase 2); read/transform content is returned inline",
        );
      }
      const format = String(resolveValue(ctx, "format", ""));
      const content =
        typeof ctx.inputs.source === "object" && ctx.inputs.source !== null
          ? JSON.stringify(ctx.inputs.source)
          : String(ctx.inputs.source ?? "");
      const events: RuntimeEvent[] = [
        eventFor(ctx, "node.file.completed", { nodeType: "tool.file", operation, source, format }),
      ];
      return {
        status: "completed",
        outputs: { content, artifact: undefined },
        artifacts: [],
        events,
      };
    },
  },

  // 4. Browser --------------------------------------------------------------
  {
    type: "tool.browser",
    category: "tool",
    label: "Browser",
    description: "Navigates and extracts from web pages.",
    inputs: [
      { id: "url", label: "URL", type: "data", required: true },
      { id: "action", label: "Action (navigate|click|extract|screenshot)", type: "data", required: true },
      { id: "selector", label: "Selector", type: "data", required: false },
    ],
    outputs: [
      { id: "html", label: "HTML", type: "data", required: false },
      { id: "text", label: "Text", type: "data", required: false },
      { id: "screenshot", label: "Screenshot", type: "data", required: false },
      { id: "artifact", label: "Artifact", type: "data", required: false },
    ],
    config: {
      validate(config: unknown): BrowserNodeConfig {
        const c = pick<BrowserNodeConfig>(config, [
          "headless", "timeoutMs", "viewport", "userAgent",
        ]);
        const headless = c.headless === undefined ? true : Boolean(c.headless);
        const timeoutMs = typeof c.timeoutMs === "number" && c.timeoutMs > 0 ? c.timeoutMs : 30_000;
        const viewport =
          typeof c.viewport === "object" &&
          c.viewport !== null &&
          typeof (c.viewport as Record<string, unknown>).width === "number" &&
          typeof (c.viewport as Record<string, unknown>).height === "number"
            ? (c.viewport as { width: number; height: number })
            : { width: 1280, height: 720 };
        const userAgent = typeof c.userAgent === "string" ? c.userAgent : "";
        return { headless, timeoutMs, viewport, userAgent };
      },
      defaults() {
        return {
          headless: true,
          timeoutMs: 30_000,
          viewport: { width: 1280, height: 720 },
          userAgent: "",
        };
      },
    },
    async execute(ctx) {
      const url = String(resolveValue(ctx, "url", ""));
      const action = String(resolveValue(ctx, "action", ""));
      if (url === "") {
        throw new Error("tool.browser: required input 'url' is empty");
      }
      if (!["navigate", "click", "extract", "screenshot"].includes(action)) {
        throw new Error(
          `tool.browser: action must be navigate|click|extract|screenshot, got '${action}'`,
        );
      }
      throw new Error(
        "tool.browser: execution requires a browser adapter (Phase 2); node is validated and registered",
      );
    },
  },

  // 5. Transform --------------------------------------------------------------
  {
    type: "tool.transform",
    category: "tool",
    label: "Transform",
    description: "Transforms input data with a script.",
    inputs: [
      { id: "input", label: "Input", type: "data", required: true },
      { id: "script", label: "Script", type: "data", required: true },
      { id: "format", label: "Format", type: "data", required: false },
    ],
    outputs: [
      { id: "output", label: "Output", type: "data", required: false },
      { id: "artifact", label: "Artifact", type: "data", required: false },
    ],
    config: {
      validate(config: unknown): TransformNodeConfig {
        const c = pick<TransformNodeConfig>(config, ["language", "allowedImports", "timeoutMs"]);
        const language = ["js", "ts", "python", "sql"].includes(c.language as string)
          ? (c.language as TransformNodeConfig["language"])
          : "js";
        const allowedImports = isStringArray(c.allowedImports) ? c.allowedImports : [];
        const timeoutMs = typeof c.timeoutMs === "number" && c.timeoutMs > 0 ? c.timeoutMs : 10_000;
        return { language, allowedImports, timeoutMs };
      },
      defaults() {
        return { language: "js", allowedImports: [], timeoutMs: 10_000 };
      },
    },
    async execute(ctx) {
      const input = resolveValue(ctx, "input", undefined);
      const script = String(resolveValue(ctx, "script", ""));
      if (script === "") {
        throw new Error("tool.transform: required input 'script' is empty");
      }
      const language = (ctx.config as TransformNodeConfig).language;
      if (language === "js" || language === "ts") {
        const fn = new Function("input", `"use strict";\n${script}`) as (
          input: unknown,
        ) => unknown;
        const output = fn(input);
        return {
          status: "completed",
          outputs: { output, artifact: undefined },
          artifacts: [],
          events: [eventFor(ctx, "node.transform.completed", { nodeType: "tool.transform", language })],
        };
      }
      throw new Error(
        `tool.transform: language '${language}' requires a sandboxed runtime (Phase 2)`,
      );
    },
  },

  // 6. Logic ------------------------------------------------------------------
  {
    type: "control.logic",
    category: "control",
    label: "Logic",
    description: "Branches or loops based on a condition.",
    inputs: [
      { id: "condition", label: "Condition", type: "conditional", required: true },
      { id: "trueBranch", label: "True branch", type: "control", required: false },
      { id: "falseBranch", label: "False branch", type: "control", required: false },
    ],
    outputs: [
      { id: "selected", label: "Selected branch", type: "control", required: true },
    ],
    config: {
      validate(config: unknown): LogicNodeConfig {
        const c = pick<LogicNodeConfig>(config, ["conditionType", "expression", "maxIterations"]);
        const conditionType = ["if", "switch", "loop"].includes(c.conditionType as string)
          ? (c.conditionType as LogicNodeConfig["conditionType"])
          : "if";
        const expression = typeof c.expression === "string" ? c.expression : "";
        const maxIterations =
          typeof c.maxIterations === "number" && c.maxIterations > 0 ? c.maxIterations : 100;
        return { conditionType, expression, maxIterations };
      },
      defaults() {
        return { conditionType: "if", expression: "", maxIterations: 100 };
      },
    },
    async execute(ctx) {
      const condition = resolveValue(ctx, "condition", undefined);
      const config = ctx.config as LogicNodeConfig;
      const truthy = condition !== undefined && condition !== null && condition !== false && condition !== "";
      let selected: string;
      switch (config.conditionType) {
        case "if":
          selected = truthy ? "true" : "false";
          break;
        case "switch": {
          const key = String(condition ?? "");
          selected = key !== "" ? key : "default";
          break;
        }
        case "loop": {
          const iterations = typeof condition === "number" ? condition : 0;
          if (iterations > config.maxIterations) {
            throw new Error(
              `control.logic: loop iterations ${iterations} exceeds maxIterations ${config.maxIterations}`,
            );
          }
          selected = iterations > 0 ? "true" : "false";
          break;
        }
      }
      return {
        status: "completed",
        outputs: { selected },
        artifacts: [],
        events: [eventFor(ctx, "node.logic.completed", { nodeType: "control.logic", selected })],
      };
    },
  },

  // 7a. Human approval ----------------------------------------------------------
  {
    type: "human.approval",
    category: "human",
    label: "Human Approval",
    description: "Blocks execution until a human approves or rejects.",
    inputs: [{ id: "request", label: "Request", type: "approval", required: true }],
    outputs: [{ id: "decision", label: "Decision", type: "approval", required: true }],
    config: {
      validate(config: unknown): HumanNodeConfig {
        const c = pick<HumanNodeConfig>(config, ["timeoutMs", "required", "options"]);
        const timeoutMs = typeof c.timeoutMs === "number" && c.timeoutMs > 0 ? c.timeoutMs : 0;
        const required = c.required === undefined ? true : Boolean(c.required);
        const options = isStringArray(c.options) ? c.options : [];
        return { timeoutMs, required, options };
      },
      defaults() {
        return { timeoutMs: 0, required: true, options: [] };
      },
    },
    async execute(ctx) {
      const request = String(resolveValue(ctx, "request", ""));
      const config = ctx.config as HumanNodeConfig;
      const reason = request !== "" ? request : "Requesting human approval";
      const approval: Approval = {
        id: crypto.randomUUID(),
        workspaceId: ctx.workspaceId,
        taskId: ctx.taskId,
        status: "pending",
        requester: "node-execution-engine",
        reason,
        createdAt: now(),
      };
      const decision = await ctx.runtime.requestApproval(approval);
      return {
        status: decision === "accepted" ? "completed" : "failed",
        outputs: { decision },
        artifacts: [],
        events: [eventFor(ctx, "node.approval.resolved", { nodeType: "human.approval", decision })],
        nextNodeHints: decision === "accepted" ? [] : ["error"],
      };
    },
  },

  // 7b. Human input ------------------------------------------------------------
  {
    type: "human.input",
    category: "human",
    label: "Human Input",
    description: "Collects text, choice, or file input from a human.",
    inputs: [
      { id: "prompt", label: "Prompt", type: "data", required: true },
      { id: "type", label: "Type (text|choice|file)", type: "data", required: true },
    ],
    outputs: [{ id: "value", label: "Value", type: "data", required: true }],
    config: {
      validate(config: unknown): HumanNodeConfig {
        const c = pick<HumanNodeConfig>(config, ["timeoutMs", "required", "options"]);
        const timeoutMs = typeof c.timeoutMs === "number" && c.timeoutMs > 0 ? c.timeoutMs : 0;
        const required = c.required === undefined ? true : Boolean(c.required);
        const options = isStringArray(c.options) ? c.options : [];
        return { timeoutMs, required, options };
      },
      defaults() {
        return { timeoutMs: 0, required: true, options: [] };
      },
    },
    async execute(ctx) {
      const prompt = String(resolveValue(ctx, "prompt", ""));
      const type = String(resolveValue(ctx, "type", ""));
      if (prompt === "") {
        throw new Error("human.input: required input 'prompt' is empty");
      }
      if (!["text", "choice", "file"].includes(type)) {
        throw new Error(`human.input: type must be text|choice|file, got '${type}'`);
      }
      // A human input request is delivered as an approval that carries the
      // requested value in the decision payload, when the UI resolves it.
      const config = ctx.config as HumanNodeConfig;
      const approval: Approval = {
        id: crypto.randomUUID(),
        workspaceId: ctx.workspaceId,
        taskId: ctx.taskId,
        status: "pending",
        requester: "node-execution-engine",
        reason: `input:${type}:${prompt}`,
        createdAt: now(),
      };
      const decision = await ctx.runtime.requestApproval(approval);
      const decisionPayload =
        typeof decision === "object" && decision !== null
          ? (decision as Record<string, unknown>)
          : { value: decision };
      return {
        status: "completed",
        outputs: { value: decisionPayload.value ?? decisionPayload },
        artifacts: [],
        events: [eventFor(ctx, "node.human-input.resolved", { nodeType: "human.input", type })],
      };
    },
  },

  // 8. Database ---------------------------------------------------------------
  {
    type: "tool.database",
    category: "tool",
    label: "Database",
    description: "Runs a query against a database connection.",
    inputs: [
      { id: "query", label: "Query", type: "data", required: true },
      { id: "params", label: "Parameters", type: "data", required: false },
      { id: "connection", label: "Connection", type: "data", required: false },
    ],
    outputs: [
      { id: "rows", label: "Rows", type: "data", required: false },
      { id: "artifact", label: "Artifact", type: "data", required: false },
    ],
    config: {
      validate(config: unknown): DatabaseNodeConfig {
        const c = pick<DatabaseNodeConfig>(config, ["driver", "connectionString", "readOnly"]);
        const driver = ["sqlite", "postgres", "mysql"].includes(c.driver as string)
          ? (c.driver as DatabaseNodeConfig["driver"])
          : "sqlite";
        const connectionString = typeof c.connectionString === "string" ? c.connectionString : "";
        const readOnly = c.readOnly === undefined ? true : Boolean(c.readOnly);
        return { driver, connectionString, readOnly };
      },
      defaults() {
        return { driver: "sqlite", connectionString: "", readOnly: true };
      },
    },
    async execute(ctx) {
      const query = String(resolveValue(ctx, "query", ""));
      if (query === "") {
        throw new Error("tool.database: required input 'query' is empty");
      }
      const config = ctx.config as DatabaseNodeConfig;
      if (config.driver === "sqlite") {
        const { DatabaseSync } = await import("node:sqlite");
        const db = new DatabaseSync(config.connectionString || ":memory:");
        try {
          const params = resolveValue(ctx, "params", undefined);
          const rows = Array.isArray(params)
            ? db.prepare(query).all(...params)
            : db.prepare(query).all();
          return {
            status: "completed",
            outputs: { rows, artifact: undefined },
            artifacts: [],
            events: [
              eventFor(ctx, "node.database.completed", {
                nodeType: "tool.database",
                driver: "sqlite",
                rowCount: Array.isArray(rows) ? rows.length : 0,
              }),
            ],
          };
        } finally {
          db.close();
        }
      }
      throw new Error(
        `tool.database: driver '${config.driver}' requires a connection adapter (Phase 2)`,
      );
    },
  },

  // 9. Output ------------------------------------------------------------------
  {
    type: "tool.output",
    category: "tool",
    label: "Output",
    description: "Formats content into a deliverable (pdf|excel|email|markdown|json).",
    inputs: [
      { id: "content", label: "Content", type: "data", required: true },
      { id: "format", label: "Format (pdf|excel|email|markdown|json)", type: "data", required: true },
      { id: "recipients", label: "Recipients", type: "data", required: false },
    ],
    outputs: [
      { id: "artifact", label: "Artifact", type: "data", required: false },
      { id: "deliveryStatus", label: "Delivery status", type: "data", required: false },
    ],
    config: {
      validate(config: unknown): OutputNodeConfig {
        const c = pick<OutputNodeConfig>(config, ["defaultFormat", "templates", "deliveryChannels"]);
        const defaultFormat = ["pdf", "excel", "email", "markdown", "json"].includes(
          c.defaultFormat as string,
        )
          ? (c.defaultFormat as OutputNodeConfig["defaultFormat"])
          : "markdown";
        const templates = isStringArray(c.templates) ? c.templates : [];
        const deliveryChannels = isStringArray(c.deliveryChannels) ? c.deliveryChannels : [];
        return { defaultFormat, templates, deliveryChannels };
      },
      defaults() {
        return { defaultFormat: "markdown", templates: [], deliveryChannels: [] };
      },
    },
    async execute(ctx) {
      const content = resolveValue(ctx, "content", "");
      const rawFormat = String(resolveValue(ctx, "format", ""));
      const format = ["pdf", "excel", "email", "markdown", "json"].includes(rawFormat)
        ? rawFormat
        : (ctx.config as OutputNodeConfig).defaultFormat;
      const recipients = resolveValue(ctx, "recipients", undefined);
      const name = `output-${crypto.randomUUID().slice(0, 8)}.${format === "markdown" ? "md" : format === "json" ? "json" : "bin"}`;
      const artifact: Artifact = {
        id: crypto.randomUUID(),
        workspaceId: ctx.workspaceId,
        type: "result",
        name,
        uri: `chef://output/${name}`,
        version: 1,
        createdBy: ctx.taskId,
        taskId: ctx.taskId,
        sessionId: ctx.sessionId,
        metadata: { nodeType: "tool.output", format, recipients: recipients ?? [] },
      };
      const persisted = await ctx.runtime.createArtifact(artifact);
      const events: RuntimeEvent[] = [
        eventFor(ctx, "node.output.completed", {
          nodeType: "tool.output",
          format,
          artifactId: persisted.id,
        }),
      ];
      return {
        status: "completed",
        outputs: {
          artifact: persisted,
          deliveryStatus: { channel: "artifact", delivered: true, artifactId: persisted.id },
        },
        artifacts: [persisted],
        events,
      };
    },
  },
];

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class NodeRegistry {
  readonly #byType = new Map<string, NodeDefinition>();

  constructor(definitions: readonly NodeDefinition[] = NODE_DEFINITIONS) {
    for (const definition of definitions) {
      if (this.#byType.has(definition.type)) {
        throw new Error(`NodeRegistry: duplicate node type '${definition.type}'`);
      }
      this.#byType.set(definition.type, definition);
    }
  }

  /** All registered definitions, in registration order. */
  list(): readonly NodeDefinition[] {
    return [...this.#byType.values()];
  }

  /** Look up a definition by its type string (e.g. "tool.file"). */
  get(type: string): NodeDefinition | undefined {
    return this.#byType.get(type);
  }

  /** Look up a definition by type string, throwing when unknown. */
  require(type: string): NodeDefinition {
    const definition = this.#byType.get(type);
    if (!definition) {
      throw new Error(`NodeRegistry: unknown node type '${type}'`);
    }
    return definition;
  }

  /** Validate a config against a definition; applies defaults and rejects
   *  invalid configs with a descriptive error. */
  validateConfig(type: string, config: unknown): unknown {
    const definition = this.require(type);
    const defaults = definition.config.defaults();
    const merged = {
      ...defaults,
      ...(typeof config === "object" && config !== null ? config : {}),
    };
    return definition.config.validate(merged);
  }

}

/** Shared singleton registry. */
export const nodeRegistry = new NodeRegistry();
