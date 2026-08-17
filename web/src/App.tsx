import { useCallback, useEffect, useRef, useState } from "react";
import { BlueprintCanvas } from "./BlueprintCanvas";
import { NodePalette } from "./NodePalette";
import { ChatPanel } from "./ChatPanel";
import { api } from "./api";
import { NODE_LIBRARY, registerHarnesses, subscribeLibrary } from "./nodeCatalog";
import { TerminalView } from "./TerminalView";
import type { UiTask, HarnessInfo, NodeCatalogEntry, UiCanvasNode, UiCanvasEdge } from "./types";
export function App() {
  const [tasks, setTasks] = useState<UiTask[]>([]);
  const [canvasNodes, setCanvasNodes] = useState<UiCanvasNode[]>([]);
  const [canvasEdges, setCanvasEdges] = useState<UiCanvasEdge[]>([]);
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
  const [isDispatching, setIsDispatching] = useState(false);
  const [approvals, setApprovals] = useState<Array<{ id: string; reason: string; taskId: string; status: string }>>([]);
  const [showPalette, setShowPalette] = useState(true);
  const [harnesses, setHarnesses] = useState<HarnessInfo[]>([]);
  const librarySubRef = useRef<(() => void) | null>(null);
  const sseRef = useRef<EventSource | null>(null);
  const pollingRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const snapshot = await api.stateRaw();
      setTasks(snapshot.tasks);
      setCanvasNodes(snapshot.canvasNodes);
      setCanvasEdges(snapshot.canvasEdges);
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
    async (source: string, target: string) => {
      try {
        const result = await api.patchCanvas({ upsertEdges: [{ source, target }] });
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

  const handleDisconnect = useCallback(
    async (source: string, target: string) => {
      try {
        const result = await api.patchCanvas({ deleteEdges: [{ source, target }] });
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
        const { taskId } = await api.createNode({
          type: payload.type,
          title,
          kind: entry?.kind,
          position,
          config: {},
          assignedTo: payload.harnessId,
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
      }
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

  const handleDispatch = useCallback(async () => {
    if (isDispatching) return;
    setIsDispatching(true);
    try {
      await api.dispatch();
      void refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to dispatch");
    } finally {
      setIsDispatching(false);
    }
  }, [isDispatching, refresh]);

  const handleRunSelected = useCallback(async () => {
    if (!selectedTask) return;
    try {
      await api.runNode({ nodeId: selectedTask.id, title: selectedTask.title, workflowNodeId: selectedTask.workflowNodeId });
      void refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to run node");
    }
  }, [selectedTask, refresh]);

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
          <span className="text-[11px] text-[#8b949e] hidden sm:inline">AI Workflow Studio</span>
        </div>

        {/* Status chips */}
        <div className="flex items-center gap-2 text-[11px]">
          {runningCount > 0 && (
            <span className="flex items-center gap-1.5 rounded-full bg-green-500/10 border border-green-500/30 px-2.5 py-1 text-green-400">
              <span className="h-1.5 w-1.5 rounded-full bg-green-400 animate-pulse" />
              {runningCount} running
            </span>
          )}
          {pendingCount > 0 && (
            <span className="rounded-full bg-[#21262d] border border-[#30363d] px-2.5 py-1 text-[#8b949e]">
              {pendingCount} queued
            </span>
          )}
          {failedCount > 0 && (
            <span className="rounded-full bg-red-500/10 border border-red-500/30 px-2.5 py-1 text-red-400">
              {failedCount} failed
            </span>
          )}
          {completedCount > 0 && (
            <span className="rounded-full bg-blue-500/10 border border-blue-500/30 px-2.5 py-1 text-blue-400">
              {completedCount} done
            </span>
          )}
          <button
            onClick={handleDispatch}
            disabled={isDispatching}
            className="ml-2 px-3 py-1 rounded-full bg-cyan-500 text-[#010409] font-medium hover:bg-cyan-400 disabled:opacity-50 transition-colors"
          >
            {isDispatching ? "Dispatching..." : "▶ Run"}
          </button>
        </div>
      </header>

      {/* ── Main area ── */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Chat panel (fixed 380px) */}
        <aside className="w-[380px] flex-shrink-0 border-r border-[#30363d] bg-[#0d1117]">
          <ChatPanel onPlanProposed={handlePlanProposed} />
        </aside>

        {/* Right: Canvas + collapsible palette */}
        <main className="flex-1 flex relative min-w-0">
          {showPalette && (
            <aside className="w-[220px] flex-shrink-0 border-r border-[#21262d] bg-[#0d1117] transition-width duration-200 ease-out">
              <NodePalette onDragStart={(type, event) => {
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
            />

            {/* Selected node toolbar */}
            {selectedTask && (
              <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 rounded-lg border border-[#30363d] bg-[#0d1117]/95 backdrop-blur px-3 py-2 shadow-lg">
                <span className="text-xs text-[#8b949e] max-w-[160px] truncate">{selectedTask.title}</span>
                <span className={`text-[10px] uppercase px-1.5 py-0.5 rounded ${statusPill(selectedTask.status)}`}>{selectedTask.status}</span>
                <div className="w-px h-4 bg-[#30363d]" />
                <button onClick={handleRunSelected} className="text-[11px] px-2 py-1 rounded bg-cyan-500/15 text-cyan-400 hover:bg-cyan-500/25">
                  Run
                </button>
                {selectedTask.status === "failed" && (
                  <button onClick={handleRetrySelected} className="text-[11px] px-2 py-1 rounded bg-amber-500/15 text-amber-400 hover:bg-amber-500/25">
                    Retry
                  </button>
                )}
                <button onClick={handleDeleteSelected} className="text-[11px] px-2 py-1 rounded bg-red-500/15 text-red-400 hover:bg-red-500/25">
                  Delete
                </button>
              </div>
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