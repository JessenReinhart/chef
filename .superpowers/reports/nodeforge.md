# NodeForge Phase 1 Report

## Commit
- `731047b` — feat: node registry + execution engine (Phase 1)

## Files Created
| File | Lines | Purpose |
|------|-------|---------|
| `src/core/nodes.ts` | 110 | UI-independent node contracts (spec §12) — types, ports, schemas, execution context/result |
| `src/runtime/node-registry.ts` | 903 | Typed registry with all 9 node definitions + `NodeRegistry` class |
| `src/runtime/node-execution-engine.ts` | 880 | Engine executing runnable graph nodes via runtime adapters |
| `tests/node-registry.ts` | 528 | Focused acceptance tests for all 7 criteria |

## Acceptance Criteria — All Passing ✅

| # | Criterion | Test Coverage |
|---|-----------|---------------|
| 1 | Registry lookup by type string returns correct definition | `registry-lookup` — 10 type strings registered, `get`/`require` verified |
| 2 | Config validation rejects invalid, applies defaults | `config-validation` — invalid model/type/boolean rejected; defaults applied for all 9 |
| 3 | Graph validation: unique IDs, valid types, port matching, acyclic control edges, required inputs | `graph-validation` — 10 error codes tested |
| 4 | Linear chain File → Transform → Output executes, emits reconstructable events/artifacts | `linear-chain` — 3 nodes, data edges, artifact persisted, events queryable, task rows created |
| 5 | Approval node blocks downstream until `requestApproval` resolves | `approval-blocking` — execution pauses, `resolveApproval` unblocks, event emitted |
| 6 | Failure on node N stops downstream unless error edge catches it | `failure-propagation` — failing node → downstream failed; error edge → catcher runs with `_error` |
| 7 | Cancellation propagates and updates statuses | `cancellation` — `cancel(graphId)` aborts, all nodes + tasks marked cancelled |

## Exported Symbols

### `src/core/nodes.ts`
```typescript
// Types (re-exported for downstream)
Approval, ApprovalDecision, ApprovalStatus
Artifact, ContextReference, EntityRef, Harness, RuntimeEvent
SessionId, TaskId, WorkspaceId

// Node contract surface
NodeCategory, NodeStatus
PortDefinition, ConfigSchema, NodeDefinition
NodeExecutionContext, NodeExecutionResult
```

### `src/runtime/node-registry.ts`
```typescript
// Registry & definitions
NODE_DEFINITIONS (readonly tuple of 10 NodeDefinition)
NodeRegistry class: list(), get(type), require(type), validateConfig(type, config)
nodeRegistry (singleton instance)

// Node config types
AgentNodeConfig, TerminalNodeConfig, FileNodeConfig, BrowserNodeConfig
TransformNodeConfig, LogicNodeConfig, HumanNodeConfig, DatabaseNodeConfig, OutputNodeConfig
```

### `src/runtime/node-execution-engine.ts`
```typescript
// Engine
NodeExecutionEngine class: executeGraph(), cancel(graphId), resolveApproval()
NodeExecutionEngineOptions

// Execution model
GraphNodeSpec, GraphEdgeSpec, ExecutionGraph, ExecutionResult
GraphNodeInstance, GraphEdgeInstance

// Validation
validateGraph() → GraphValidationResult { valid, errors[] }
```

## Node Definitions Implemented (9 categories, 10 types)

| Type | Category | Ports | Config | Execution |
|------|----------|-------|--------|-----------|
| `agent.llm` | agent | prompt/context/tools → response/artifacts/handoff | model, temperature, maxTokens, systemPrompt, tools[], permissionPolicy | Validates + registered; throws (Phase 2) |
| `tool.terminal` | tool | command/cwd/env → stdout/stderr/exitCode | shell, cols, rows, timeoutMs, allowInteractive | PTY harness + runCommand() |
| `tool.file` | tool | source/operation/format → content/artifact | basePath, allowedExtensions[], maxSizeBytes | Read/transform inline; write throws (Phase 2) |
| `tool.browser` | tool | url/action/selector → html/text/screenshot/artifact | headless, timeoutMs, viewport, userAgent | Validates + registered; throws (Phase 2) |
| `tool.transform` | tool | input/script/format → output/artifact | language (js/ts/python/sql), allowedImports[], timeoutMs | JS/TS via `new Function`; others throw |
| `control.logic` | control | condition/trueBranch/falseBranch → selected | conditionType (if/switch/loop), expression, maxIterations | Boolean/switch/loop with bounds |
| `human.approval` | human | request → decision | timeoutMs, required, options[] | `requestApproval` polling repo |
| `human.input` | human | prompt/type → value | timeoutMs, required, options[] | `requestApproval` with payload |
| `tool.database` | tool | query/params/connection → rows/artifact | driver (sqlite/postgres/mysql), connectionString, readOnly | sqlite executes; others throw (Phase 2) |
| `tool.output` | tool | content/format/recipients → artifact/deliveryStatus | defaultFormat, templates[], deliveryChannels[] | Creates artifact via repository |

## Concerns / Deviations from Brief

1. **`DecisionStatus` type error in `database.ts`** — pre-existing issue (not introduced by this work). `DecisionStatus` is exported from `core/types.ts` but not found when typechecking `database.ts` in isolation. Does not affect runtime.

2. **Human nodes share approval infrastructure** — `human.input` uses the same approval polling as `human.approval` (carries type+prompt in `reason`). A dedicated input channel is Phase 2.

3. **Tool.file write / browser / non-JS transform / non-sqlite DB** — throw descriptive errors per "no fake providers". Validation + registration works; execution deferred to Phase 2 adapters.

4. **Transform JS execution uses `new Function`** — no sandboxing in Phase 1. Phase 2 will add sandboxed runtimes.

5. **Cancellation signature** — `cancel(graphId: string)` aborts all executions for that graph (returns count), not a single executionId. More useful for callers.

6. **Test uses `node --experimental-strip-types`** — matches existing test suite pattern.

## Verification
- All 13 existing tests pass (`npm test`)
- All 7 new acceptance tests pass (`node --experimental-strip-types tests/node-registry.ts`)
- TypeScript strict mode clean for 4 new files (pre-existing `database.ts` issue unrelated)