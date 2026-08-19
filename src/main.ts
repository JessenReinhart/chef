import type {
  AgentId,
  Approval,
  ApprovalDecision,
  ContextReference,
  DecisionProvider,
  EntityRef,
  HarnessEvent,
  HarnessId,
  Mission,
  AutomationRun,
  OrchestratorResult,
  RuntimeEvent,
  Session,
  TaskId,
  WorkspaceId,
  WorkspaceSnapshot,
  CanvasNode,
  CanvasEdge,
  CanvasPatch,
  CanvasPatchResult,
} from "./core/types.ts";
import { Repository, type TemplateInput } from "./persistence/database.ts";
import type { ChatMessage } from "./persistence/chat.ts";
import { GenericTerminalHarness } from "./harness/generic.ts";
import { Scheduler, type HarnessLike, type HarnessRegistry } from "./runtime/scheduler.ts";
import { HarnessRegistry as SpecializedHarnessRegistry } from "./runtime/harness-registry.ts";
import { ToolRunner } from "./runtime/tool-runner.ts";
import { BrowserTool } from "./runtime/browser-tool.ts";
import { AutomationRunner } from "./runtime/automation-runner.ts";
import { McpRegistry } from "./runtime/mcp-client.ts";
import {
  Orchestrator,
  ScriptedDecisionProvider,
  type OrchestratorDecisionProvider,
  type OrchestratorHarness,
  type RuntimeAdapter,
} from "./orchestrator/orchestrator.ts";
import { createLLMDecisionProvider, readLLMProviderConfig } from "./orchestrator/llm-decision-provider.ts";

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
    writeMessage: (sessionId: string, from: string, text: string) => harness.writeMessage(sessionId, from, text),
    events: (sessionId: string) => harness.events(sessionId),
    send: (sessionId: string, input: string) => harness.send(sessionId, input),
    interrupt: (sessionId: string) => harness.interrupt(sessionId),
    resize: (sessionId: string, cols: number, rows: number) => harness.resize(sessionId, cols, rows),
    terminate: (sessionId: string) => harness.terminate(sessionId),
    forget: (sessionId: string) => harness.forget(sessionId),
    close: () => harness.close(),
  };
}

/** Whether the LLM decision provider is active, and what it resolves to. */
export interface LLMStatus {
  configured: boolean;
  provider: string | null;
  model: string | null;
}

export interface ChefRuntime {
  readonly workspaceId: WorkspaceId;
  readonly repository: Repository;
  readonly projectDir: string;
  start(): Promise<void>;
  sendUserMessage(message: string): Promise<OrchestratorResult>;
  /** Retry a failed/blocked task through the scheduler's retry budget. */
  retryTask(taskId: TaskId): Promise<void>;
  /** Send a chat message and stream assistant replies via SSE. */
  sendChatMessage(message: string): Promise<OrchestratorResult>;
  /** Write a peer message envelope into a live session's inbox (message_peer). */
  sendPeerMessage(sessionId: string, fromAgentId: string, text: string): Promise<void>;
  /** Ask the scheduler to dispatch any runnable pending tasks (blueprint canvas). */
  dispatchPending(): Promise<number>;
  /** Forward a harness event to the scheduler for task lifecycle updates. */
  handleSessionEvent(sessionId: string, event: HarnessEvent): Promise<void>;
  /** Register a harness for a specific agent id (blueprint canvas dispatch). */
  registerHarness(agentId: string, harness: HarnessLike): void;
  /** Apply a durable canvas graph mutation (validate → write → arrange → emit). */
  patchCanvas(workspaceId: WorkspaceId, patch: CanvasPatch): Promise<CanvasPatchResult>;
  /** LLM decision-provider status (mirrors createLLMDecisionProvider's env resolution). */
  readonly llmStatus: LLMStatus;
  /** Read the durable canvas graph projection. */
  listCanvas(workspaceId: WorkspaceId): { nodes: CanvasNode[]; edges: CanvasEdge[] };
  /** Read one consistent durable workspace snapshot. */
  inspectState(): Promise<WorkspaceSnapshot>;
  activateNode(nodeId: string): Promise<CanvasNode>;
  interveneNode(nodeId: string, message: string): Promise<void>;
  pauseMission(missionId: string): Promise<Mission>;
  resumeMission(missionId: string): Mission;
  cancelMission(missionId: string): Promise<Mission>;
  redirectMission(missionId: string, goal: string): Promise<Mission>;
  runAutomation(automationId: string): AutomationRun;
  stopAutomation(automationId: string): Promise<AutomationRun>;
  cancelTask(taskId: TaskId): Promise<void>;
  sendInput(sessionId: string, input: string): Promise<void>;
  interruptSession(sessionId: string): Promise<void>;
  resizeSession(sessionId: string, cols: number, rows: number): Promise<void>;
  resolveApproval(approvalId: string, decision: ApprovalDecision, approver: string): Promise<Approval>;
  subscribeEvents(listener: (event: RuntimeEvent) => void): () => void;
  close(): Promise<void>;
  /** Phase 8: deterministic tool runner (terminal/filesystem/git + approval gates). */
  readonly toolRunner: ToolRunner;
  /** Phase 8: browser sessions (Playwright; honest error when absent). */
  readonly browserTool: BrowserTool;
  /** Phase 8: MCP capability client registry. */
  readonly mcpRegistry: McpRegistry;
  /** Known specialized harness candidates with live availability detection. */
  readonly specializedHarnesses: SpecializedHarnessRegistry;
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
  const specializedHarnesses = new SpecializedHarnessRegistry({
    workspaceId,
    cwd: options.projectDir,
  });

  // Surface LLM provider status (same env logic as createLLMDecisionProvider:
  // a provider is "configured" when it has a provider value AND a resolved key).
  const llmConfig = readLLMProviderConfig();
  const llmConfigured = !!(llmConfig.provider && llmConfig.apiKey);
  const llmStatus: LLMStatus = {
    configured: llmConfigured,
    provider: llmConfigured ? llmConfig.provider : null,
    model: llmConfigured ? llmConfig.model : null,
  };

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
    dispatchPending: (wsId, allowedTaskIds) => scheduler.dispatchPending(wsId, allowedTaskIds),
    handleSessionEvent: (wsId, sessionId, event) => scheduler.handleSessionEvent(wsId, sessionId, event),
    recoverOnStartup: (wsId) => scheduler.recoverOnStartup(wsId),
    cancelTask: (wsId, taskId) => scheduler.cancelTask(wsId, taskId),
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
  const automationRunner = new AutomationRunner(repository, scheduler, runtimeRegistry, (event) => {
    for (const listener of listeners) {
      try { listener(event); } catch { /* Projections cannot abort execution. */ }
    }
  });
  const standaloneConsumers = new Map<string, Promise<void>>();
  let runtimeClosing = false;

  // Mission and Automation execution own their session iterators separately.
  // Public canvas/server dispatches opt into this owner callback so each PTY
  // has exactly one durable event consumer from spawn through terminal exit.
  const consumeStandaloneSession = (session: Session): void => {
    if (standaloneConsumers.has(session.id)) return;
    const harness = runtimeRegistry.get(session.agentId);
    if (!harness) return;
    const consumption = Promise.resolve().then(async () => {
      try {
        for await (const event of harness.events(session.id)) {
          await scheduler.handleSessionEvent(workspaceId, session.id, event);
        }
      } catch (error) {
        const current = repository.listSessions(workspaceId).find((candidate) => candidate.id === session.id);
        if (current?.status === "spawning" || current?.status === "running") {
          await scheduler.handleSessionEvent(workspaceId, session.id, { type: "crash", exitCode: 1 });
        }
        if (!runtimeClosing) {
          console.error(`standalone session ${session.id} event consumer failed:`, error);
        }
      } finally {
        try { await harness.forget(session.id); } catch { /* Harness may already be closed. */ }
      }
    }).finally(() => {
      standaloneConsumers.delete(session.id);
    });
    standaloneConsumers.set(session.id, consumption);
  };

  const dispatchStandalone = (allowedTaskIds?: readonly TaskId[]): Promise<number> => {
    if (runtimeClosing) return Promise.reject(new Error("Chef runtime is closing"));
    return scheduler.dispatchPending(workspaceId, allowedTaskIds, consumeStandaloneSession);
  };

  const toolRunner = new ToolRunner({
    workspaceId,
    projectDir: options.projectDir,
    harnessRegistry: runtimeRegistry,
    capabilities: { agentId: "human", workspaceId, role: "human" },
    emitEvent: (event) => {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch {
          // Inspector failures must not abort authoritative runtime writes.
        }
      }
    },
    persistApproval: (approval) => {
      repository.insertApproval({
        workspaceId,
        taskId: approval.taskId,
        status: approval.status,
        requester: approval.requester,
        reason: approval.reason,
        createdAt: approval.createdAt,
      });
    },
  });
  const browserTool = new BrowserTool();
  const mcpRegistry = new McpRegistry();
  return {
    workspaceId,
    repository,
    projectDir: options.projectDir,
    specializedHarnesses,
    llmStatus,
    toolRunner,
    browserTool,
    mcpRegistry,
    async start(): Promise<void> {
      await scheduler.recoverOnStartup(workspaceId);
      // Detect and register specialized harnesses (Claude Code, Pi, OMP,
      // Freebuff) — binary absence is reported, not fatal.
      await specializedHarnesses.initialize();
      // Wire specialized harnesses into the scheduler's registry so dispatch
      // can find them by agent id (task.assignedTo). The orchestrator must
      // observe the same adapter's event stream; otherwise its provider
      // fallback would replace this live owner with a generic harness.
      for (const harness of specializedHarnesses.values()) {
        runtimeRegistry.set(harness.id as AgentId, harness);
        orchestratorRegistry.set(harness.id as AgentId, {
          id: harness.id,
          events: (sessionId: string) => harness.events(sessionId),
          terminate: (sessionId: string) => harness.terminate(sessionId),
          forget: (sessionId: string) => harness.forget(sessionId),
        });
      }
      // Always register a generic PTY harness under the "generic" agent id so
      // canvas nodes assigned to "generic" (palette advertises it as always
      // available) can actually dispatch. Command resolved at spawn time via
      // the harness command surface (node fallback).
      if (!runtimeRegistry.get("generic")) {
        runtimeRegistry.set(
          "generic",
          asSchedulerHarness(new GenericTerminalHarness({ agentId: "generic", workspaceId, command: "node", cwd: options.projectDir })),
        );
      }
      automationRunner.resumeActive(workspaceId);
      try {
        await mcpRegistry.connectAll();
      } catch {
        // MCP servers are optional — absence must not break startup.
      }
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
    patchCanvas(workspaceId: WorkspaceId, patch: CanvasPatch): Promise<CanvasPatchResult> {
      return orchestrator.patchCanvasGraph(workspaceId, patch);
    },
    listCanvas(workspaceId: WorkspaceId): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
      return orchestrator.listCanvasGraph(workspaceId);
    },
    async activateNode(nodeId: string): Promise<CanvasNode> {
      const node = orchestrator.activateCanvasNode(workspaceId, nodeId);
      if (node.taskId) {
        const task = repository.getTask(node.taskId);
        if (task?.assignedTo && (task.status === "pending" || task.status === "assigned")) {
          await dispatchStandalone([task.id]);
        }
      }
      return node;
    },
    async interveneNode(nodeId: string, message: string): Promise<void> {
      orchestrator.interveneCanvasNode(workspaceId, nodeId, message);
      const node = orchestrator.listCanvasGraph(workspaceId).nodes.find((candidate) => candidate.id === nodeId);
      if (!node?.taskId) return;
      const interventionTask = repository.getTask(node.taskId);
      if (!interventionTask?.assignedTo) return;
      // Interventions are durable above; when the node has executable work,
      // also activate only that task and wait briefly for its PTY inbox.
      await dispatchStandalone([node.taskId]);
      const deadline = Date.now() + 1_000;
      while (Date.now() < deadline) {
        const session = repository.listSessions(workspaceId).find(
          (candidate) => candidate.taskId === node.taskId && (candidate.status === "spawning" || candidate.status === "running"),
        );
        if (session) {
          await scheduler.send(workspaceId, session.id, `${message}\n`);
          return;
        }
        const task = repository.getTask(node.taskId);
        if (!task || task.status === "completed" || task.status === "failed" || task.status === "cancelled") return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    pauseMission(missionId: string): Promise<Mission> {
      return orchestrator.pauseMission(workspaceId, missionId);
    },
    resumeMission(missionId: string): Mission {
      return orchestrator.resumeMission(workspaceId, missionId);
    },
    cancelMission(missionId: string): Promise<Mission> {
      return orchestrator.cancelMission(workspaceId, missionId);
    },
    redirectMission(missionId: string, goal: string): Promise<Mission> {
      return orchestrator.redirectMission(workspaceId, missionId, goal);
    },
    runAutomation(automationId: string): AutomationRun {
      return automationRunner.run(automationId);
    },
    stopAutomation(automationId: string): Promise<AutomationRun> {
      return automationRunner.stop(automationId);
    },
    cancelTask(taskId: TaskId): Promise<void> {
      return scheduler.cancelTask(workspaceId, taskId);
    },
    sendInput(sessionId: string, input: string): Promise<void> {
      return scheduler.send(workspaceId, sessionId, input);
    },
    sendPeerMessage(sessionId: string, fromAgentId: string, text: string): Promise<void> {
      return scheduler.sendPeerMessage(workspaceId, sessionId, fromAgentId, text);
    },
    interruptSession(sessionId: string): Promise<void> {
      return scheduler.interrupt(workspaceId, sessionId);
    },
    retryTask(taskId: TaskId): Promise<void> {
      return scheduler.retryTask(workspaceId, taskId);
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
    dispatchPending(): Promise<number> {
      return dispatchStandalone();
    },
    handleSessionEvent(sessionId: string, event: HarnessEvent): Promise<void> {
      return scheduler.handleSessionEvent(workspaceId, sessionId, event);
    },
    registerHarness(agentId: string, harness: HarnessLike): void {
      runtimeRegistry.set(agentId as AgentId, harness);
    },
    async close(): Promise<void> {
      runtimeClosing = true;
      automationRunner.close();
      // Every harness close is attempted; a rejected harness teardown must not
      // skip the repository close (durable state + DB lock release).
      await Promise.allSettled([
        ...[...runtimeRegistry.values()].map((harness) => harness.close()),
        specializedHarnesses.close(),
        browserTool.close(),
        mcpRegistry.close(),
      ]);
      // Harness close terminates PTYs and closes their event queues. Let every
      // standalone consumer persist the resulting exit before closing SQLite.
      await Promise.allSettled([...standaloneConsumers.values()]);
      repository.close();
    },
  };
}
