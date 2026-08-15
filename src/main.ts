import type {
  AgentId,
  Approval,
  ApprovalDecision,
  ContextReference,
  DecisionProvider,
  EntityRef,
  HarnessEvent,
  HarnessId,
  OrchestratorResult,
  RuntimeEvent,
  TaskId,
  WorkspaceId,
  WorkspaceSnapshot,
} from "./core/types.ts";
import { Repository, type TemplateInput } from "./persistence/database.ts";
import { GenericTerminalHarness } from "./harness/generic.ts";
import { Scheduler, type HarnessLike, type HarnessRegistry } from "./runtime/scheduler.ts";
import {
  Orchestrator,
  ScriptedDecisionProvider,
  type OrchestratorDecisionProvider,
  type OrchestratorHarness,
  type RuntimeAdapter,
} from "./orchestrator/orchestrator.ts";
import { createLLMDecisionProvider } from "./orchestrator/llm-decision-provider.ts";

class RuntimeHarnessRegistry implements HarnessRegistry {
  readonly #byAgent = new Map<AgentId, HarnessLike>();

  get(agentId: AgentId): HarnessLike | undefined {
    return this.#byAgent.get(agentId);
  }

  set(agentId: AgentId, harness: HarnessLike): void {
    this.#byAgent.set(agentId, harness);
  }
  values(): Iterable<HarnessLike> {
    return this.#byAgent.values();
  }
}

class OrchestratorHarnessRegistry {
  readonly #byAgent = new Map<AgentId, OrchestratorHarness>();

  get(agentId: AgentId): OrchestratorHarness | undefined {
    return this.#byAgent.get(agentId);
  }

  set(agentId: AgentId, harness: OrchestratorHarness): void {
    this.#byAgent.set(agentId, harness);
  }

  has(agentId: AgentId): boolean {
    return this.#byAgent.has(agentId);
  }
}

function asSchedulerHarness(harness: GenericTerminalHarness): HarnessLike {
  return {
    id: harness.id,
    command: harness.command,
    args: harness.args,
    cwd: harness.cwd ?? process.cwd(),
    spawn: async (options) => {
      const session = await harness.spawn(options);
      return { id: session.id, pid: session.pid };
    },
    writeContextRefs: (sessionId: string, refs: ContextReference[]) => harness.writeContextRefs(sessionId, refs),
    events: (sessionId: string) => harness.events(sessionId),
    send: (sessionId: string, input: string) => harness.send(sessionId, input),
    interrupt: (sessionId: string) => harness.interrupt(sessionId),
    resize: (sessionId: string, cols: number, rows: number) => harness.resize(sessionId, cols, rows),
    terminate: (sessionId: string) => harness.terminate(sessionId),
    forget: (sessionId: string) => harness.forget(sessionId),
    close: () => harness.close(),
  };
}

export interface ChefRuntime {
  readonly workspaceId: WorkspaceId;
  readonly repository: Repository;
  start(): Promise<void>;
  sendUserMessage(message: string): Promise<OrchestratorResult>;
  inspectState(): Promise<WorkspaceSnapshot>;
  cancelTask(taskId: TaskId): Promise<void>;
  sendInput(sessionId: string, input: string): Promise<void>;
  interruptSession(sessionId: string): Promise<void>;
  resizeSession(sessionId: string, cols: number, rows: number): Promise<void>;
  /** Resolve a pending human approval gate (spec §11.3). */
  resolveApproval(approvalId: string, decision: ApprovalDecision, approver: string, reason?: string): Promise<Approval>;
  subscribeEvents(listener: (event: RuntimeEvent) => void): () => void;
  /** Send a chat message and stream assistant replies via SSE. */
  sendChatMessage(message: string): Promise<OrchestratorResult>;
  close(): Promise<void>;
}
export function createChef(options: {
  dbPath: string;
  projectDir: string;
  decisionProvider?: DecisionProvider;
  /** Plan execution timeout in ms (default 60s). Short values force timeout paths. */
  orchestratorTimeoutMs?: number;
  /** Chat persistence for SSE streaming */
  chatRepository?: { list: (workspaceId: WorkspaceId) => ChatMessage[]; insert: (input: { role: string; content: string; metadata?: Record<string, unknown> }) => ChatMessage };
}): ChefRuntime {
  const repository = new Repository(options.dbPath);
  let workspaceId = repository.getWorkspaceId();
  if (!workspaceId) {
    workspaceId = repository.createWorkspace({ name: "Chef", rootPath: options.projectDir }).id;
    repository.insertProject({ workspaceId, name: "Chef", rootPath: options.projectDir });
  }

  // Seed the four Simple Mode templates (idempotent by name; skip when a
  // workspace already has templates so user edits are never overwritten).
  const SEED_TEMPLATES: Omit<TemplateInput, "workspaceId">[] = [
    {
      name: "Monthly Financial Report",
      description:
        "Generate a complete monthly financial report with income statement, balance sheet, and cash flow summary. Includes data validation and approval gate.",
      nodes: [
        { id: "fetch-data", type: "tool.file", title: "Fetch Financial Data", config: { title: "Fetch Financial Data", description: "Pull transaction data from accounting system" } },
        { id: "validate", type: "tool.transform", title: "Validate Data", config: { title: "Validate Data", description: "Check for missing entries, duplicates, anomalies" } },
        { id: "generate-report", type: "agent.llm", title: "Generate Report", config: { title: "Generate Report", description: "Build income statement, balance sheet, cash flow" } },
        { id: "review", type: "human.approval", title: "CFO Review", config: { title: "CFO Review", description: "Human approval before finalizing" } },
        { id: "deliver", type: "tool.output", title: "Deliver Report", config: { title: "Deliver Report", description: "Export PDF and email stakeholders" } },
      ],
      metadata: { category: "financial", estimatedDuration: "15 min", tags: ["monthly", "reporting", "cfo"] },
    },
    {
      name: "Cash Flow Analysis",
      description:
        "Analyze cash inflows/outflows, forecast runway, and identify trends. Outputs a dashboard-ready summary with alerts.",
      nodes: [
        { id: "fetch-cash", type: "tool.file", title: "Fetch Cash Data", config: { title: "Fetch Cash Data", description: "Pull bank transactions and AR/AP" } },
        { id: "categorize", type: "tool.transform", title: "Categorize Flows", config: { title: "Categorize Flows", description: "Classify operating, investing, financing" } },
        { id: "forecast", type: "agent.llm", title: "Forecast Runway", config: { title: "Forecast Runway", description: "Project cash position 13 weeks forward" } },
        { id: "alert-review", type: "human.approval", title: "Alert Review", config: { title: "Alert Review", description: "Flag negative projections for review" } },
        { id: "dashboard", type: "tool.output", title: "Update Dashboard", config: { title: "Update Dashboard", description: "Push metrics to monitoring dashboard" } },
      ],
      metadata: { category: "financial", estimatedDuration: "10 min", tags: ["cash-flow", "forecast", "runway"] },
    },
    {
      name: "Budget vs Actual",
      description:
        "Compare budgeted vs actual spend by department/category. Highlights variances >10% and routes exceptions for review.",
      nodes: [
        { id: "fetch-budget", type: "tool.file", title: "Fetch Budget", config: { title: "Fetch Budget", description: "Load approved budget from planning system" } },
        { id: "fetch-actual", type: "tool.file", title: "Fetch Actuals", config: { title: "Fetch Actuals", description: "Pull YTD actual spend from ERP" } },
        { id: "variance", type: "tool.transform", title: "Calculate Variance", config: { title: "Calculate Variance", description: "Compute $ and % variance by line item" } },
        { id: "flag", type: "control.logic", title: "Flag Exceptions", config: { title: "Flag Exceptions", description: "Mark items exceeding 10% threshold" } },
        { id: "exception-review", type: "human.approval", title: "Exception Review", config: { title: "Exception Review", description: "Department heads justify variances" } },
        { id: "variance-report", type: "tool.output", title: "Variance Report", config: { title: "Variance Report", description: "Generate executive summary with charts" } },
      ],
      metadata: { category: "financial", estimatedDuration: "12 min", tags: ["budget", "variance", "department"] },
    },
    {
      name: "Developer Fix/Verify",
      description:
        "Standardized bug fix workflow: reproduce → fix → test → verify → deploy. Includes automated test gate and deploy approval.",
      nodes: [
        { id: "reproduce", type: "tool.terminal", title: "Reproduce Issue", config: { title: "Reproduce Issue", description: "Create minimal failing test case" } },
        { id: "diagnose", type: "agent.llm", title: "Root Cause", config: { title: "Root Cause", description: "Identify and document root cause" } },
        { id: "fix", type: "tool.terminal", title: "Implement Fix", config: { title: "Implement Fix", description: "Write fix with unit test" } },
        { id: "test-gate", type: "control.logic", title: "Test Gate", config: { title: "Test Gate", description: "Run full suite; block on failures" } },
        { id: "deploy-approval", type: "human.approval", title: "Deploy Approval", config: { title: "Deploy Approval", description: "Lead review before production deploy" } },
        { id: "deploy", type: "tool.terminal", title: "Deploy & Verify", config: { title: "Deploy & Verify", description: "Deploy to prod and verify resolution" } },
      ],
      metadata: { category: "operations", estimatedDuration: "30 min", tags: ["bug-fix", "ci-cd", "verification"] },
    },
  ];
  if (repository.listTemplates(workspaceId).length === 0) {
    for (const seed of SEED_TEMPLATES) {
      repository.insertTemplate({ ...seed, workspaceId });
    }
  }

  const runtimeRegistry = new RuntimeHarnessRegistry();
  const orchestratorRegistry = new OrchestratorHarnessRegistry();

  // Use LLM provider from env if configured, otherwise use provided or scripted
  const llmProvider = options.decisionProvider ?? createLLMDecisionProvider();
  const scripted = llmProvider ?? new ScriptedDecisionProvider();
  const provider: OrchestratorDecisionProvider = {
    name: scripted.name,
    proposePlan: (input) => scripted.proposePlan(input),
    evaluate: (taskResult) => scripted.evaluate(taskResult),
    harnessFor(agentId: AgentId, wsId: WorkspaceId): OrchestratorHarness {
      const candidate = "harnessFor" in scripted && typeof scripted.harnessFor === "function"
        ? scripted.harnessFor(agentId, wsId)
        : new GenericTerminalHarness({ agentId, workspaceId: wsId, command: "node", cwd: options.projectDir });
      const harness = candidate as GenericTerminalHarness;
      runtimeRegistry.set(agentId, asSchedulerHarness(harness));
      const orchestratorHarness: OrchestratorHarness = {
        id: harness.id,
        events: (sessionId: string) => harness.events(sessionId),
        terminate: (sessionId: string) => harness.terminate(sessionId),
        forget: (sessionId: string) => harness.forget(sessionId),
      };
      orchestratorRegistry.set(agentId, orchestratorHarness);
      return orchestratorHarness;
    },
  };
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const scheduler = new Scheduler(repository, runtimeRegistry, {
    maxConcurrency: 1,
    onEvent: (event) => {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch {
          // Inspector failures must not abort authoritative runtime writes.
        }
      }
    },
  });
  const runtimeAdapter: RuntimeAdapter = {
    dispatchPending: (wsId) => scheduler.dispatchPending(wsId),
    handleSessionEvent: (wsId, sessionId, event) => scheduler.handleSessionEvent(wsId, sessionId, event),
    recoverOnStartup: (wsId) => scheduler.recoverOnStartup(wsId),
  };
  const orchestrator = new Orchestrator({
    repository,
    runtime: runtimeAdapter,
    harnessRegistry: orchestratorRegistry,
    decisionProvider: provider,
    timeoutMs: options.orchestratorTimeoutMs,
    onEvent: (event) => {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch {
          // Inspector failures must not abort authoritative runtime writes.
        }
      }
    },
  });

  return {
    workspaceId,
    repository,
    async start(): Promise<void> {
      await scheduler.recoverOnStartup(workspaceId);
    },
    sendUserMessage(message: string): Promise<OrchestratorResult> {
      return orchestrator.handleUserMessage(workspaceId, message);
    },
    sendChatMessage(message: string): Promise<OrchestratorResult> {
      return orchestrator.handleChatMessage(workspaceId, message);
    },
    inspectState(): Promise<WorkspaceSnapshot> {
      return orchestrator.inspectState(workspaceId);
    },
    cancelTask(taskId: TaskId): Promise<void> {
      return scheduler.cancelTask(workspaceId, taskId);
    },
    sendInput(sessionId: string, input: string): Promise<void> {
      return scheduler.send(workspaceId, sessionId, input);
    },
    interruptSession(sessionId: string): Promise<void> {
      return scheduler.interrupt(workspaceId, sessionId);
    },
    resizeSession(sessionId: string, cols: number, rows: number): Promise<void> {
      return scheduler.resize(workspaceId, sessionId, cols, rows);
    },
    resolveApproval(approvalId: string, decision: ApprovalDecision, approver: string): Promise<Approval> {
      return scheduler.resolveApproval(workspaceId, approvalId, decision, approver);
    },
    subscribeEvents(listener: (event: RuntimeEvent) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async close(): Promise<void> {
      // Every harness close is attempted; a rejected harness teardown must not
      // skip the repository close (durable state + DB lock release).
      await Promise.allSettled([...runtimeRegistry.values()].map((harness) => harness.close()));
      repository.close();
    },
  };
}
