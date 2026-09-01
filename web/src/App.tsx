import { useCallback, useEffect, useRef, useState } from "react";
import { BlueprintCanvas } from "./BlueprintCanvas";
import { NodePalette } from "./NodePalette";
import { ChatPanel } from "./ChatPanel";
import { MissionPanel } from "./MissionPanel";
import { api } from "./api";
import { NODE_LIBRARY, registerHarnesses, subscribeLibrary } from "./nodeCatalog";
import { TerminalView } from "./TerminalView";
import { BrowserSurface } from "./BrowserSurface";
import { SELECTED_THREAD_EVENT } from "./threadApi";
import type {
  UiTask,
  HarnessInfo,
  UiCanvasNode,
  UiCanvasEdge,
  EdgeRelationship,
  MissionStatus,
  ViewMode,
  UiMission,
  UiAutomation,
  UiRuntimeEvent,
} from "./types";

const RELATIONSHIPS: Array<{ value: EdgeRelationship; simple: string; power: string }> = [
  { value: "communication", simple: "Talks with", power: "Communication" },
  { value: "context", simple: "Shares context", power: "Context / data" },
  { value: "delegation", simple: "Can delegate to", power: "Delegation" },
  { value: "dependency", simple: "Waits for", power: "Dependency (sequential)" },
  { value: "control", simple: "Routes to", power: "Control (sequential)" },
  { value: "error", simple: "Handles failure", power: "Error route" },
  { value: "approval", simple: "Needs review from", power: "Approval gate" },
];

function missionStatusFor(tasks: UiTask[], pendingApprovals: number): MissionStatus {
  if (pendingApprovals > 0) return "waiting_for_approval";
  if (tasks.some((task) => task.status === "blocked")) return "blocked";
  if (tasks.some((task) => task.status === "running" || task.status === "assigned" || task.status === "spawning")) return "active";
  if (tasks.length > 0 && tasks.every((task) => task.status === "completed")) return "completed";
  if (tasks.some((task) => task.status === "failed")) return "failed";
  if (tasks.some((task) => task.status === "pending")) return "planning";
  return "idle";
}

const MISSION_LABELS: Record<MissionStatus, string> = {
  idle: "Workspace ready",
  planning: "Mission planning",
  active: "Mission active",
  paused: "Mission paused",
  waiting_for_approval: "Mission needs approval",
  blocked: "Mission blocked",
  verifying: "Mission verifying",
  completed: "Mission completed",
  cancelled: "Mission cancelled",
  failed: "Mission needs attention",
};
export function App() {
  const [tasks, setTasks] = useState<UiTask[]>([]);
  const [canvasNodes, setCanvasNodes] = useState<UiCanvasNode[]>([]);
  const [canvasEdges, setCanvasEdges] = useState<UiCanvasEdge[]>([]);
  const [missions, setMissions] = useState<UiMission[]>([]);
  const [automations, setAutomations] = useState<UiAutomation[]>([]);
  const [events, setEvents] = useState<UiRuntimeEvent[]>([]);
  const [selectedTask, setSelectedTask] = useState<UiTask | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Terminal canvas nodes mount a live TerminalView. This state picks which
  // node's session the terminal is tied to. TerminalView self-manages its own
  // SSE stream via /api/events?types=session.data; App only needs the ids.
  const [terminalSelection, setTerminalSelection] = useState<{ nodeId: string | null; sessionId: string | null }>({
    nodeId: null,
    sessionId: null,
  });
  // Live agent sessions snapshot, polled so terminal nodes can resolve a
  // task id → session id and mount a TerminalView against it.
  const [sessions, setSessions] = useState<Array<{ id: string; taskId: string; status: string; pid: number }>>([]);
  const [mode, setMode] = useState<ViewMode>(() => localStorage.getItem("chef:view-mode") === "power" ? "power" : "simple");
  const [relationship, setRelationship] = useState<EdgeRelationship>("communication");
  const [showAutomation, setShowAutomation] = useState(false);
  const [showMissionControls, setShowMissionControls] = useState(false);
  const [redirectGoal, setRedirectGoal] = useState("");
  const [approvals, setApprovals] = useState<Array<{ id: string; reason: string; taskId: string; status: string }>>([]);
  const [showPalette, setShowPalette] = useState(true);
  const [harnesses, setHarnesses] = useState<HarnessInfo[]>([]);
  const [capabilityPolicies, setCapabilityPolicies] = useState<Record<string, Record<string, "allow" | "deny" | "approval">>>({});
  const [intervention, setIntervention] = useState("");
  const librarySubRef = useRef<(() => void) | null>(null);
  const sseRef = useRef<EventSource | null>(null);
  const pollingRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const snapshot = await api.stateRaw();
      setTasks(snapshot.tasks);
      setCanvasNodes(snapshot.canvasNodes);
      setCanvasEdges(snapshot.canvasEdges);
      setMissions(snapshot.missions ?? []);
      setAutomations(snapshot.automations ?? []);
      setEvents(snapshot.events ?? []);
      const pending = snapshot.approvals.filter((a) => a.status === "pending");
      setApprovals(pending);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load state");
    }
  }, []);

  useEffect(() => {
    void refresh();
    pollingRef.current = window.setInterval(() => void refresh(), 1500);
    return () => {
      if (pollingRef.current) window.clearInterval(pollingRef.current);
    };
  }, [refresh]);

  useEffect(() => {
    const onThreadChanged = () => {
      // The previous snapshot belongs to another conversation. Invalidate it
      // synchronously so the header, canvas, approvals, and controls cannot
      // present stale Thread activity while the new scoped snapshot loads.
      setTasks([]);
      setCanvasNodes([]);
      setCanvasEdges([]);
      setMissions([]);
      setEvents([]);
      setApprovals([]);
      setSelectedTask(null);
      setTerminalSelection({ nodeId: null, sessionId: null });
      setShowMissionControls(false);
      void refresh();
    };
    window.addEventListener(SELECTED_THREAD_EVENT, onThreadChanged);
    return () => window.removeEventListener(SELECTED_THREAD_EVENT, onThreadChanged);
  }, [refresh]);

  // Poll sessions for terminal canvas nodes so each node can resolve its
  // task id to an active session id. TerminalView consumes session.data SSE
  // itself — App only maintains the id mapping here.
  const sessionsPollRef = useRef<number | null>(null);
  const refreshSessions = useCallback(async () => {
    try {
      const list = await api.sessions();
      setSessions(list);
    } catch {
      // sessions optional — keep prior snapshot
    }
  }, []);
  useEffect(() => {
    void refreshSessions();
    sessionsPollRef.current = window.setInterval(() => void refreshSessions(), 2000);
    return () => {
      if (sessionsPollRef.current) window.clearInterval(sessionsPollRef.current);
    };
  }, [refreshSessions]);

  // SSE /api/events — canvas.patched events trigger an immediate refresh
  // (no wait for the next poll tick).
  useEffect(() => {
    const es = new EventSource("/api/events?types=canvas.*");
    sseRef.current = es;
    es.addEventListener("canvas.patched", () => void refresh());
    es.onerror = () => {
      // EventSource auto-reconnects; nothing to do here.
    };
    return () => {
      es.close();
      sseRef.current = null;
    };
  }, [refresh]);

  // Fetch harnesses on mount
  useEffect(() => {
    api.harnesses().then((h) => {
      setHarnesses(h);
      registerHarnesses(h);
    }).catch(() => {
      // harnesses optional
    });
  }, []);

  useEffect(() => {
    Promise.all((["engineer", "orchestrator", "human"] as const).map((role) => api.capabilities(role)))
      .then((items) => setCapabilityPolicies(Object.fromEntries(items.map((item) => [item.role, item.policy]))))
      .catch(() => {
        // Keep the inspector honest when policy projection is unavailable.
        setCapabilityPolicies({});
      });
  }, []);

  // Keep palette in sync with NODE_LIBRARY changes
  useEffect(() => {
    const unsub = subscribeLibrary(() => {
      // force re-render by updating harnesses reference
      setHarnesses((prev) => [...prev]);
    });
    librarySubRef.current = unsub;
    return () => unsub();
  }, []);

  const handleConnect = useCallback(
    async (source: string, target: string, edgeRelationship: EdgeRelationship) => {
      try {
        const result = await api.patchCanvas({ upsertEdges: [{ source, target, type: edgeRelationship }] });
        if (result.ok) {
          if (result.nodes) setCanvasNodes(result.nodes);
          if (result.edges) setCanvasEdges(result.edges);
        } else if (result.error) {
          setError(result.error);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to create edge");
      }
    },
    [],
  );

  const toggleMode = useCallback(() => {
    setMode((current) => {
      const next = current === "simple" ? "power" : "simple";
      localStorage.setItem("chef:view-mode", next);
      return next;
    });
  }, []);

  const handleDisconnect = useCallback(
    async (source: string, target: string, edgeRelationship: EdgeRelationship) => {
      try {
        const result = await api.patchCanvas({ deleteEdges: [{ source, target, type: edgeRelationship }] });
        if (result.ok) {
          if (result.nodes) setCanvasNodes(result.nodes);
          if (result.edges) setCanvasEdges(result.edges);
        } else if (result.error) {
          setError(result.error);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to remove edge");
      }
    },
    [],
  );

  const handleDropNode = useCallback(
    async (payload: { type: string; harnessId?: string }, position: { x: number; y: number }) => {
      try {
        const entry = NODE_LIBRARY.find((n) => n.type === payload.type);
        const title = entry?.label ?? payload.type;
        const isTaskBackedInteractiveNode = entry?.kind === "agent" || payload.type === "tool.terminal";
        const isBrowserSurface = payload.type === "tool.browser";
        const { taskId } = await api.createNode({
          type: payload.type,
          title,
          kind: entry?.kind,
          position,
          config: {},
          assignedTo: payload.harnessId,
          // Agents and inspectable surfaces join the living workspace now;
          // they are never held behind a canvas-wide dispatch action.
          autoDispatch: isTaskBackedInteractiveNode,
        });
        // POST /api/nodes creates a task only — persist a canvas node that
        // references the task (with the dropped position) via patchCanvas.
        await api.patchCanvas({
          upsertNodes: [
            {
              id: taskId,
              taskId,
              label: title,
              nodeType: "blueprint",
              kind: entry?.kind === "agent" ? "agent" : "tool",
              harnessId: payload.harnessId ?? entry?.harnessId ?? null,
              position,
            },
          ],
        });
        if (isBrowserSurface) await api.activateNode(taskId);
        void refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to create node");
      }
    },
    [refresh],
  );

  const handleNodeDragStop = useCallback(async (id: string, position: { x: number; y: number }, label: string) => {
    try {
      const result = await api.patchCanvas({
        upsertNodes: [{ id, label, position }],
      });
      if (!result.ok && result.error) {
        setError(result.error);
        return;
      }
      const zones = await api.contextZones();
      await Promise.all(zones.flatMap((zone) => {
        const inside = position.x >= zone.bounds.x
          && position.x <= zone.bounds.x + zone.bounds.width
          && position.y >= zone.bounds.y
          && position.y <= zone.bounds.y + zone.bounds.height;
        const wasMember = zone.memberNodeIds.includes(id);
        if (inside === wasMember) return [];
        const memberNodeIds = inside
          ? [...zone.memberNodeIds, id].sort()
          : zone.memberNodeIds.filter((nodeId) => nodeId !== id);
        return [api.updateContextZone(zone.id, { memberNodeIds })];
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update position");
    }
  }, []);
  const handleSelectNode = useCallback(
    (task: UiTask | null) => {
      setSelectedTask(task);
      if (task) {
        const session = sessions.find((s) => s.taskId === task.id);
        setTerminalSelection({ nodeId: task.id, sessionId: session?.id ?? null });
      } else {
        setTerminalSelection({ nodeId: null, sessionId: null });
      }
    },
    [sessions],
  );

  const handleActivateSelected = useCallback(async () => {
    if (!selectedTask) return;
    const node = canvasNodes.find((candidate) => candidate.taskId === selectedTask.id || candidate.id === selectedTask.id);
    if (!node) return;
    try {
      await api.activateNode(node.id);
      void refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to activate node");
    }
  }, [selectedTask, canvasNodes, refresh]);

  const handleInterveneSelected = useCallback(async () => {
    const text = intervention.trim();
    if (!selectedTask || !text) return;
    const node = canvasNodes.find((candidate) => candidate.taskId === selectedTask.id || candidate.id === selectedTask.id);
    if (!node) return;
    try {
      await api.interveneNode(node.id, text);
      setIntervention("");
      void refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send intervention");
    }
  }, [intervention, selectedTask, canvasNodes, refresh]);

  const handleInterruptSelected = useCallback(async () => {
    if (!selectedTask) return;
    const session = sessions.find((candidate) => candidate.taskId === selectedTask.id);
    if (!session) return;
    try {
      await api.interruptSession(session.id);
      void refreshSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to interrupt session");
    }
  }, [selectedTask, sessions, refreshSessions]);

  const handleAutomationAction = useCallback(async (automation: UiAutomation) => {
    try {
      if (automation.status === "running") await api.stopAutomation(automation.id);
      else await api.runAutomation(automation.id);
      void refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Automation action failed");
    }
  }, [refresh]);

  const handleMissionAction = useCallback(async (mission: UiMission, action: "pause" | "resume" | "cancel") => {
    try {
      await api.controlMission(mission.id, action);
      void refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Mission action failed");
    }
  }, [refresh]);

  const handleMissionRedirect = useCallback(async (mission: UiMission) => {
    const goal = redirectGoal.trim();
    if (!goal) return;
    try {
      await api.redirectMission(mission.id, goal);
      setRedirectGoal("");
      void refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Mission redirect failed");
    }
  }, [redirectGoal, refresh]);

  const handleRetrySelected = useCallback(async () => {
    if (!selectedTask) return;
    try {
      await api.retryNode(selectedTask.id);
      void refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to retry node");
    }
  }, [selectedTask, refresh]);

  const handleDeleteSelected = useCallback(async () => {
    if (!selectedTask) return;
    try {
      await api.deleteNode(selectedTask.id);
      setSelectedTask(null);
      void refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete node");
    }
  }, [selectedTask, refresh]);

  const handlePlanProposed = useCallback((_taskIds: string[]) => {
    void refresh();
  }, [refresh]);

  const handleApprove = useCallback(
    async (approvalId: string, decision: "accept" | "reject") => {
      try {
        await api.approve(approvalId, decision);
        setApprovals((prev) => prev.filter((a) => a.id !== approvalId));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Approval failed");
      }
    },
    [],
  );

  const runningCount = tasks.filter((t) => t.status === "running" || t.status === "spawning" || t.status === "assigned").length;
  const completedCount = tasks.filter((t) => t.status === "completed").length;
  const failedCount = tasks.filter((t) => t.status === "failed").length;
  const pendingCount = tasks.filter((t) => t.status === "pending").length;
  const latestMission = [...missions].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const missionStatus = latestMission?.status ?? missionStatusFor(tasks, approvals.length);
  const selectedCanvasNode = selectedTask ? canvasNodes.find((node) => node.taskId === selectedTask.id || node.id === selectedTask.id) : undefined;
  const selectedIsSurface = selectedCanvasNode?.kind === "tool";
  const selectedIsAgent = selectedCanvasNode?.kind === "agent";
  const selectedIsBrowser = selectedTask?.workflowNodeId === "tool.browser";
  const selectedSession = selectedTask ? sessions.find((session) => session.taskId === selectedTask.id) : undefined;
  const selectedEvents = selectedTask
    ? events.filter((event) => event.taskId === selectedTask.id || (selectedSession && event.sessionId === selectedSession.id)).slice(-12).reverse()
    : [];
  const selectedPolicyRole = selectedIsAgent ? "engineer" : "human";
  const configuredPermissions = selectedCanvasNode?.config?.permissions;
  const selectedPermissionPolicy = configuredPermissions && typeof configuredPermissions === "object" && !Array.isArray(configuredPermissions)
    ? configuredPermissions as Record<string, unknown>
    : capabilityPolicies[selectedPolicyRole];
  const selectedUsage = selectedEvents.reduce<{ tokens?: number; cost?: number }>((usage, event) => {
    if (!event.payload || typeof event.payload !== "object") return usage;
    const payload = event.payload as Record<string, unknown>;
    const tokens = payload.tokens ?? payload.totalTokens ?? payload.tokenCount;
    const cost = payload.cost ?? payload.costUsd;
    return {
      tokens: typeof tokens === "number" ? tokens : usage.tokens,
      cost: typeof cost === "number" ? cost : usage.cost,
    };
  }, {});

  return (
    <div className="h-screen w-screen flex flex-col bg-[#010409] text-[#e6edf3] overflow-hidden">
      {/* ── Top bar ── */}
      <header className="flex items-center justify-between h-12 px-4 border-b border-[#21262d] bg-[#0d1117] z-20">
        <div className="flex items-center gap-2">
          <svg className="h-5 w-5 text-cyan-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M7.5 9.5a4.5 4.5 0 0 1 9 0c0 2-1.2 3.2-2.5 4.2V16h-4v-2.3c-1.3-1-2.5-2.2-2.5-4.2z" />
            <path d="M10 19h4" />
          </svg>
          <span className="font-semibold text-sm tracking-tight">Chef</span>
          <span className="text-[11px] text-[#8b949e] hidden sm:inline">Living AI workspace</span>
        </div>

        {/* Mission pulse + presentation controls. Runtime state is shared by both modes. */}
        <div className="flex items-center gap-2 text-[11px]">
          <button className="mission-pulse" data-status={missionStatus} title={latestMission?.goal ?? `${tasks.length} workspace nodes · ${canvasEdges.length} relationships`} onClick={() => setShowMissionControls((value) => !value)} aria-expanded={showMissionControls}>
            <span className="mission-pulse__signal" />
            <span>{MISSION_LABELS[missionStatus]}</span>
            {runningCount > 0 && <span className="mission-pulse__count">{runningCount}</span>}
          </button>
          {runningCount > 0 && (
            <span className="hidden xl:inline text-[#8b949e]">{runningCount} working</span>
          )}
          {mode === "power" && pendingCount > 0 && (
            <span className="rounded-full bg-[#21262d] border border-[#30363d] px-2.5 py-1 text-[#8b949e]">
              {pendingCount} pending
            </span>
          )}
          {mode === "power" && failedCount > 0 && (
            <span className="rounded-full bg-red-500/10 border border-red-500/30 px-2.5 py-1 text-red-400">
              {failedCount} failed
            </span>
          )}
          {mode === "power" && completedCount > 0 && (
            <span className="rounded-full bg-blue-500/10 border border-blue-500/30 px-2.5 py-1 text-blue-400">
              {completedCount} done
            </span>
          )}
          <button onClick={() => setShowAutomation((value) => !value)} className="header-quiet-button" aria-expanded={showAutomation}>
            Automations
          </button>
          <button onClick={toggleMode} className="mode-switch" aria-label={`Switch to ${mode === "simple" ? "Power" : "Simple"} mode`}>
            <span className={mode === "simple" ? "mode-switch__option is-active" : "mode-switch__option"}>Simple</span>
            <span className={mode === "power" ? "mode-switch__option is-active" : "mode-switch__option"}>Power</span>
          </button>
        </div>
      </header>

      {showMissionControls && latestMission && (
        <MissionPanel
          mission={latestMission}
          tasks={tasks}
          approvals={approvals}
          mode={mode}
          redirectGoal={redirectGoal}
          onRedirectGoalChange={setRedirectGoal}
          onAction={(action) => void handleMissionAction(latestMission, action)}
          onRedirect={() => void handleMissionRedirect(latestMission)}
        />
      )}

      {showAutomation && (
        <section className="automation-strip" aria-label="Automation controls">
          <div>
            <strong>Repeatable automations</strong>
            <span>Run and stop belong here—not to the living workspace.</span>
          </div>
          {automations.length > 0 ? (
            <div className="automation-strip__actions">
              {automations.map((automation) => (
                <div key={automation.id} className="automation-strip__item">
                  <span>{automation.name} · {automation.status}</span>
                  <button className={automation.status === "running" ? "is-stop" : undefined} onClick={() => void handleAutomationAction(automation)}>
                    {automation.status === "running" ? "Stop automation" : "Run automation"}
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <span className="automation-strip__hint">No automations yet. Repeatable graphs will appear here.</span>
          )}
        </section>
      )}

      {/* ── Main area ── */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Chat panel (fixed 380px) */}
        <aside className="w-[380px] flex-shrink-0 border-r border-[#30363d] bg-[#0d1117]">
          <ChatPanel onPlanProposed={handlePlanProposed} mode={mode} />
        </aside>

        {/* Right: Canvas + collapsible palette */}
        <main className="flex-1 flex relative min-w-0">
          {showPalette && (
            <aside className="w-[220px] flex-shrink-0 border-r border-[#21262d] bg-[#0d1117] transition-width duration-200 ease-out">
              <NodePalette mode={mode} onDragStart={(type, event) => {
                const entry = NODE_LIBRARY.find((n) => n.type === type);
                const payload = entry?.harnessId ? { type, harnessId: entry.harnessId } : { type };
                event.dataTransfer.setData("application/chef-node", JSON.stringify(payload));
                event.dataTransfer.effectAllowed = "move";
              }} />
            </aside>
          )}
          <div className="flex-1 relative min-w-0">
            <BlueprintCanvas
              tasks={tasks}
              canvasNodes={canvasNodes}
              canvasEdges={canvasEdges}
              onConnect={handleConnect}
              onDisconnect={handleDisconnect}
              onSelectNode={handleSelectNode}
              onDropNode={handleDropNode}
              onNodeDragStop={handleNodeDragStop}
              harnesses={harnesses}
              sessions={sessions}
              selectedSessionId={terminalSelection.sessionId}
              relationship={relationship}
              mode={mode}
            />

            <label className="relationship-picker">
              <span>{mode === "simple" ? "New connections" : "Edge relationship"}</span>
              <select value={relationship} onChange={(event) => setRelationship(event.target.value as EdgeRelationship)}>
                {RELATIONSHIPS.map((item) => (
                  <option key={item.value} value={item.value}>{mode === "simple" ? item.simple : item.power}</option>
                ))}
              </select>
            </label>

            {/* Selected node toolbar */}
            {selectedTask && (
              <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 rounded-lg border border-[#30363d] bg-[#0d1117]/95 backdrop-blur px-3 py-2 shadow-lg">
                <span className="text-xs text-[#8b949e] max-w-[160px] truncate">{selectedTask.title}</span>
                <span className={`text-[10px] uppercase px-1.5 py-0.5 rounded ${statusPill(selectedTask.status)}`}>{friendlyTaskStatus(selectedTask.status)}</span>
                <div className="w-px h-4 bg-[#30363d]" />
                {(selectedIsSurface || selectedIsAgent) && (
                  <button onClick={handleActivateSelected} className="text-[11px] px-2 py-1 rounded bg-cyan-500/15 text-cyan-400 hover:bg-cyan-500/25">
                    {selectedIsSurface ? "Open surface" : "Activate agent"}
                  </button>
                )}
                {selectedTask.status === "failed" && (
                  <button onClick={handleRetrySelected} className="text-[11px] px-2 py-1 rounded bg-amber-500/15 text-amber-400 hover:bg-amber-500/25">
                    Retry
                  </button>
                )}
                <button onClick={handleDeleteSelected} className="text-[11px] px-2 py-1 rounded bg-red-500/15 text-red-400 hover:bg-red-500/25">
                  Delete
                </button>
                {mode === "power" && (
                  <span
                    className="border-l border-[#30363d] pl-2 font-mono text-[9px] text-[#6e7681]"
                    title={`Task ${selectedTask.id}\nSession ${terminalSelection.sessionId ?? "none"}\nOwner ${selectedTask.assignedTo ?? "unassigned"}\nContext refs ${(selectedTask.contextRefs ?? []).map((ref) => `${ref.type}:${ref.id}`).join(", ") || "none"}`}
                  >
                    task:{selectedTask.id.slice(0, 8)} {terminalSelection.sessionId ? `· session:${terminalSelection.sessionId.slice(0, 8)}` : "· no session"} · refs:{selectedTask.contextRefs?.length ?? 0} · owner:{selectedTask.assignedTo ?? "—"}
                  </span>
                )}
              </div>
            )}

            {mode === "power" && selectedTask && (
              <aside className="power-inspector" aria-label="Power runtime inspector">
                <div className="power-inspector__header">
                  <div>
                    <span className="power-inspector__eyebrow">Runtime inspector</span>
                    <strong>{selectedTask.title}</strong>
                  </div>
                  <span className="power-inspector__live" data-status={selectedTask.status ?? selectedCanvasNode?.liveStatus}>
                    {selectedTask.status ?? selectedCanvasNode?.liveStatus}
                  </span>
                </div>

                <section>
                  <h3>Ownership & session</h3>
                  <dl className="power-inspector__grid">
                    <dt>Task</dt><dd>{selectedTask.id}</dd>
                    <dt>Owner</dt><dd>{selectedTask.assignedTo ?? "unassigned"}</dd>
                    <dt>Harness</dt><dd>{selectedCanvasNode?.harnessId ?? "none"}</dd>
                    <dt>Session</dt><dd>{selectedSession ? `${selectedSession.id} · ${selectedSession.status} · pid ${selectedSession.pid}` : "no live session"}</dd>
                  </dl>
                  {selectedSession && (selectedSession.status === "running" || selectedSession.status === "spawning") && (
                    <button className="power-inspector__session-action" onClick={() => void handleInterruptSelected()}>
                      Interrupt session
                    </button>
                  )}
                </section>

                <section>
                  <h3>Context refs</h3>
                  <div className="power-inspector__chips">
                    {(selectedTask.contextRefs ?? []).length > 0
                      ? selectedTask.contextRefs?.map((ref) => <code key={`${ref.type}:${ref.id}`}>{ref.type}:{ref.id}</code>)
                      : <span>None injected</span>}
                  </div>
                </section>

                <section>
                  <h3>Permissions</h3>
                  <div className="power-inspector__chips">
                    {selectedPermissionPolicy
                      ? Object.entries(selectedPermissionPolicy).map(([capability, permission]) => (
                        <code key={capability}>{capability}: {String(permission)}</code>
                      ))
                      : <span>Policy unavailable</span>}
                  </div>
                </section>

                <section>
                  <h3>Usage</h3>
                  <dl className="power-inspector__grid">
                    <dt>Tokens</dt><dd>{selectedUsage.tokens?.toLocaleString() ?? "not reported"}</dd>
                    <dt>Cost</dt><dd>{selectedUsage.cost === undefined ? "not reported" : `$${selectedUsage.cost.toFixed(4)}`}</dd>
                  </dl>
                </section>

                {(selectedIsAgent || selectedIsSurface) && (
                  <section>
                    <h3>Direct intervention</h3>
                    <div className="power-inspector__intervene">
                      <textarea
                        value={intervention}
                        onChange={(event) => setIntervention(event.target.value)}
                        onKeyDown={(event) => {
                          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") void handleInterveneSelected();
                        }}
                        placeholder="Send an instruction to this worker…"
                      />
                      <button onClick={() => void handleInterveneSelected()} disabled={!intervention.trim()}>Send</button>
                    </div>
                  </section>
                )}

                <section className="power-inspector__events">
                  <h3>Event history</h3>
                  {selectedEvents.length > 0 ? selectedEvents.map((event) => (
                    <div key={event.id} className="power-inspector__event">
                      <code>#{event.seq} {event.type}</code>
                      <time>{new Date(event.timestamp).toLocaleTimeString()}</time>
                    </div>
                  )) : <span>No task events yet</span>}
                </section>
              </aside>
            )}

            {selectedIsBrowser && selectedCanvasNode && (
              <BrowserSurface
                initialUrl={typeof selectedCanvasNode.config?.url === "string" ? selectedCanvasNode.config.url : "about:blank"}
                onNavigate={async (url) => {
                  await api.patchCanvas({ upsertNodes: [{
                    id: selectedCanvasNode.id,
                    label: selectedCanvasNode.label,
                    config: { ...(selectedCanvasNode.config ?? {}), url },
                  }] });
                  void refresh();
                }}
              />
            )}

            {/* Approvals toast */}
            {approvals.length > 0 && (
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 w-[420px] max-w-[90vw]">
                {approvals.map((a) => (
                  <div key={a.id} className="mb-2 rounded-lg border border-amber-500/40 bg-[#0d1117]/95 backdrop-blur p-3 shadow-xl">
                    <div className="flex items-center gap-2">
                      <svg className="h-4 w-4 text-amber-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
                      </svg>
                      <span className="text-xs font-medium text-[#e6edf3]">Approval required</span>
                    </div>
                    <p className="text-[11px] text-[#8b949e] mt-1">{a.reason}</p>
                    <div className="flex gap-2 mt-2">
                      <button onClick={() => handleApprove(a.id, "accept")} className="flex-1 text-[11px] py-1 rounded bg-green-500/15 text-green-400 hover:bg-green-500/25">
                        Approve
                      </button>
                      <button onClick={() => handleApprove(a.id, "reject")} className="flex-1 text-[11px] py-1 rounded bg-red-500/15 text-red-400 hover:bg-red-500/25">
                        Reject
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Palette toggle */}
            <button
              onClick={() => setShowPalette((v) => !v)}
              className="absolute top-3 right-3 z-10 p-2 rounded-lg border border-[#30363d] bg-[#0d1117]/95 backdrop-blur text-cyan-400 hover:bg-[#161b22] transition-colors"
              aria-label={showPalette ? "Hide palette" : "Show palette"}
            >
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                {showPalette ? (
                  <>
                    <line x1="5" y1="12" x2="19" y2="12" />
                    <line x1="5" y1="6" x2="19" y2="6" />
                    <line x1="5" y1="18" x2="19" y2="18" />
                  </>
                ) : (
                  <>
                    <line x1="19" y1="12" x2="5" y2="12" />
                    <line x1="19" y1="6" x2="5" y2="6" />
                    <line x1="19" y1="18" x2="5" y2="18" />
                  </>
                )}
              </svg>
            </button>
          </div>
        </main>
      </div>

      {/* Error toast */}
      {error && (
        <div className="fixed top-14 right-4 z-50 rounded-lg border border-red-500/40 bg-[#0d1117] p-3 shadow-xl max-w-sm">
          <p className="text-xs text-red-400">{error}</p>
          <button onClick={() => setError(null)} className="mt-1 text-[10px] text-[#8b949e] hover:text-[#e6edf3]">
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

function statusPill(status: string): string {
  switch (status) {
    case "running":
      return "bg-green-500/15 text-green-400";
    case "failed":
      return "bg-red-500/15 text-red-400";
    case "blocked":
      return "bg-amber-500/15 text-amber-400";
    case "completed":
      return "bg-blue-500/15 text-blue-400";
    default:
      return "bg-[#21262d] text-[#8b949e]";
  }
}

function friendlyTaskStatus(status: string): string {
  const labels: Record<string, string> = {
    pending: "Idle",
    assigned: "Starting",
    spawning: "Starting",
    running: "Working",
    completed: "Ready",
    failed: "Failed",
    blocked: "Blocked",
    cancelled: "Offline",
  };
  return labels[status] ?? status;
}