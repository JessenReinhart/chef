# Task 1: Core Node Registry + Execution Engine

## Context
Chef is a runtime-first AI Engineering OS. The spec mandates a node-based workflow system (spec §12) with nine node categories: AI Agent, Terminal, File/Data, Browser, Transform, Logic, Human (Approval/Input), Database, Output. The canvas is a projection; the registry is the shared contract.

## Deliverables
- `src/core/nodes.ts` — UI-independent node contracts and registry
- `src/runtime/node-registry.ts` — typed registry with definitions for all nine node types
- `src/runtime/node-execution-engine.ts` — engine that executes runnable graph nodes through runtime adapters
- Tests covering registry lookup, config validation, dependency ordering, data transfer, approval blocking, failure propagation, cancellation

## Existing touchpoints
- `src/core/graph.ts` — `GraphNode`, `GraphEdge`, `WorkflowGraph`, `buildPlanGraph`
- `src/core/types.ts` — `Task`, `Session`, `Artifact`, `ContextReference`, `RuntimeEvent`, `Harness`, `HarnessEvent`
- `src/runtime/scheduler.ts` — `Scheduler`, `TaskMachine`, dispatch, retries, event handling
- `src/context/context.ts` — `ContextManager`, resolution, inbox materialization
- `src/persistence/database.ts` — `Repository`, transactions, snapshots
- `src/harness/generic.ts` — `GenericTerminalHarness`, sideband protocol

## Required contracts (copy verbatim into `src/core/nodes.ts`)
```ts
export type NodeCategory = "agent" | "tool" | "control" | "workflow" | "human";

export type NodeStatus =
  | "idle" | "ready" | "running" | "waiting"
  | "completed" | "failed" | "cancelled";

export interface PortDefinition {
  id: string;
  label: string;
  type: "data" | "control" | "conditional" | "error" | "approval";
  required: boolean;
  description?: string;
}

export interface ConfigSchema<TConfig = unknown> {
  validate(config: unknown): TConfig;
  defaults(): Partial<TConfig>;
}

export interface NodeDefinition<TConfig = unknown> {
  type: string;
  category: NodeCategory;
  label: string;
  description: string;
  inputs: readonly PortDefinition[];
  outputs: readonly PortDefinition[];
  config: ConfigSchema<TConfig>;
  execute(ctx: NodeExecutionContext<TConfig>): Promise<NodeExecutionResult>;
}

export interface NodeExecutionContext<TConfig = unknown> {
  taskId: string;
  workspaceId: string;
  config: TConfig;
  inputs: Record<string, unknown>;
  artifacts: Artifact[];
  contextRefs: ContextReference[];
  harness: Harness;
  sessionId: string;
  runtime: {
    emitEvent: (event: RuntimeEvent) => void;
    createArtifact: (artifact: Artifact) => Promise<Artifact>;
    requestApproval: (approval: Approval) => Promise<ApprovalDecision>;
  };
}

export interface NodeExecutionResult {
  status: NodeStatus;
  outputs: Record<string, unknown>;
  artifacts: Artifact[];
  events: RuntimeEvent[];
  nextNodeHints?: string[];
}
```

## Node definitions to implement (exact types and labels from spec §12.2 and visual spec)

1. **AI Agent** (`agent.llm` / category `agent`)
   - Inputs: `prompt` (data), `context` (data), `tools` (control)
   - Outputs: `response` (data), `artifacts` (data), `handoff` (control)
   - Config: `model`, `temperature`, `maxTokens`, `systemPrompt`, `tools[]`, `permissionPolicy`

2. **Terminal** (`tool.terminal` / category `tool`)
   - Inputs: `command` (data), `cwd` (data), `env` (data)
   - Outputs: `stdout` (data), `stderr` (data), `exitCode` (data)
   - Config: `shell`, `cols`, `rows`, `timeoutMs`, `allowInteractive`

3. **File/Data** (`tool.file` / category `tool`)
   - Inputs: `source` (data), `operation` (data: read|write|transform), `format` (data)
   - Outputs: `content` (data), `artifact` (data)
   - Config: `basePath`, `allowedExtensions`, `maxSizeBytes`

4. **Browser** (`tool.browser` / category `tool`)
   - Inputs: `url` (data), `action` (data: navigate|click|extract|screenshot), `selector` (data)
   - Outputs: `html` (data), `text` (data), `screenshot` (data), `artifact` (data)
   - Config: `headless`, `timeoutMs`, `viewport`, `userAgent`

5. **Transform** (`tool.transform` / category `tool`)
   - Inputs: `input` (data), `script` (data), `format` (data)
   - Outputs: `output` (data), `artifact` (data)
   - Config: `language` (js|ts|python|sql), `allowedImports`, `timeoutMs`

6. **Logic** (`control.logic` / category `control`)
   - Inputs: `condition` (conditional), `trueBranch` (control), `falseBranch` (control)
   - Outputs: `selected` (control)
   - Config: `conditionType` (if|switch|loop), `expression`, `maxIterations`

7. **Human** (`human.approval`, `human.input` / category `human`)
   - Approval: inputs `request` (approval), outputs `decision` (approval)
   - Input: inputs `prompt` (data), `type` (data: text|choice|file), outputs `value` (data)
   - Config: `timeoutMs`, `required`, `options[]`

8. **Database** (`tool.database` / category `tool`)
   - Inputs: `query` (data), `params` (data), `connection` (data)
   - Outputs: `rows` (data), `artifact` (data)
   - Config: `driver` (sqlite|postgres|mysql), `connectionString`, `readOnly`

9. **Output** (`tool.output` / category `tool`)
   - Inputs: `content` (data), `format` (data: pdf|excel|email|markdown|json), `recipients` (data)
   - Outputs: `artifact` (data), `deliveryStatus` (data)
   - Config: `defaultFormat`, `templates`, `deliveryChannels`

## Acceptance criteria (must all pass)
- Registry lookup by type string returns correct definition
- Config validation rejects invalid configs, applies defaults
- Graph validation: unique IDs, valid types, port matching, acyclic control edges, required inputs present
- NodeExecutionEngine executes a linear chain of 3 nodes (File → Transform → Output) and emits reconstructable events/artifacts
- Approval node blocks downstream execution until `requestApproval` resolves
- Failure on node N stops downstream unless an error edge catches it
- Cancellation propagates and updates statuses
- All focused tests pass: `node --experimental-strip-types tests/node-registry.ts`

## Global constraints (from IMPLEMENTATION_PLAN.md)
- Runtime state authoritative; UI is projection
- PTY vs sideband separation preserved
- Transactional persistence through Repository
- Node >=24 native TS stripping; no enums, namespaces, parameter properties
- Graph definitions UI-library independent
- LLMs propose; runtime validates/executes
- No fake providers, placeholders, silent fallbacks, unbounded retries

## Files you may edit
- Create: `src/core/nodes.ts`
- Create: `src/runtime/node-registry.ts`
- Create: `src/runtime/node-execution-engine.ts`
- Create: `tests/node-registry.ts`
- Modify: `src/core/types.ts` (only if new types needed, prefer new file)
- Modify: `src/runtime/scheduler.ts` (only to wire engine for tests, minimal)

## Report
Write your summary to `.superpowers/reports/nodeforge.md` with:
- Commits made
- Tests added and their pass/fail status
- Any concerns or deviations from the brief