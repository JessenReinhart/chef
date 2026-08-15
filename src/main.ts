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
import { Repository } from "./persistence/database.ts";
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
