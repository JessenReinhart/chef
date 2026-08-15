import { useEffect, useState, useCallback } from "react";
import type { RuntimeEvent, WorkspaceSnapshot, Session } from "../../src/core/types.ts";
import type { GraphNode } from "../../src/core/graph.ts";
import { CanvasPanel } from "./CanvasPanel.tsx";
import { NavigationPanel } from "./NavigationPanel.tsx";
import { InspectorPanel } from "./InspectorPanel.tsx";
import { ConsolePanel } from "./ConsolePanel.tsx";
import { LogsPanel } from "./LogsPanel.tsx";
import { TerminalPanes } from "./TerminalPanes.tsx";
import { ContextBusPanel } from "./ContextBusPanel.tsx";
import { WideInspector } from "./WideInspector.tsx";
import { TemplateGallery, type Template } from "./TemplateGallery.tsx";
import { SetupWizard, getTemplateParameters, type TemplateDraft } from "./SetupWizard.tsx";
import "./workbench.css";

interface SessionInfo {
  id: string;
  taskId: string;
  status: string;
  pid: number;
}

interface DashboardState {
  snapshot: WorkspaceSnapshot | null;
  events: RuntimeEvent[];
  sessions: SessionInfo[];
}

type Mode = "simple" | "power";

function inspectorProps(
  selectedNode: GraphNode | null,
  mode: Mode,
  onConfigChange: (nodeId: string, key: string, value: unknown) => void,
) {
  return {
    selectedNode,
    mode,
    onConfigChange,
    onAcceptApproval: (node: GraphNode) => {
      const approvalId = node.config.approvalId as string | undefined;
      if (!approvalId) return;
      void fetch(`/api/approvals/${approvalId}/accept`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approver: "dashboard" }),
      });
    },
    onRejectApproval: (node: GraphNode) => {
      const approvalId = node.config.approvalId as string | undefined;
      if (!approvalId) return;
      void fetch(`/api/approvals/${approvalId}/reject`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approver: "dashboard" }),
      });
    },
  };
}

const STORAGE_KEY = "chef:mode";

export function App() {
  const [state, setState] = useState<DashboardState>({ snapshot: null, events: [], sessions: [] });
  const [input, setInput] = useState("");
  const [refreshTick, setRefreshTick] = useState(0);
  const [mode, setMode] = useState<Mode>(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "simple" || stored === "power") return stored;
    }
    return "simple";
  });
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [powerTabs, setPowerTabs] = useState<"logs" | "terminals" | "context" | "inspector">("logs");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  // Simple mode state
  const [showTemplateGallery, setShowTemplateGallery] = useState(true);
  const [showSetupWizard, setShowSetupWizard] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(null);

  // Keep the mode visible to CSS for theming and persist to localStorage.
  useEffect(() => {
    document.documentElement.dataset.mode = mode;
    localStorage.setItem(STORAGE_KEY, mode);
    return () => {
      delete document.documentElement.dataset.mode;
    };
  }, [mode]);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/state");
    const snapshot = (await res.json()) as WorkspaceSnapshot;
    const sessions: SessionInfo[] = snapshot.sessions.map((s) => ({
      id: s.id,
      taskId: s.taskId,
      status: s.status,
      pid: s.pid,
    }));
    setState((prev) => ({ ...prev, snapshot, sessions }));
    setRefreshTick((tick) => tick + 1);
  }, []);

  useEffect(() => {
    void refresh();
    const events = new EventSource("/api/events");
    events.onmessage = (msg) => {
      const event = JSON.parse(msg.data) as RuntimeEvent;
      setState((prev) => ({ ...prev, events: [...prev.events.slice(-499), event] }));
    };
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      events.close();
      clearInterval(timer);
    };
  }, [refresh]);

  const send = async () => {
    const sessionId = state.sessions.find((s) => s.status === "running")?.id;
    if (!sessionId || input.trim() === "") return;
    await fetch("/api/sessions/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, data: input }),
    });
    setInput("");
  };

  const interrupt = async () => {
    const sessionId = state.sessions.find((s) => s.status === "running")?.id;
    if (!sessionId) return;
    await fetch("/api/sessions/interrupt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
  };

  const handleDropNode = (type: string, position: { x: number; y: number }) => {
    console.info(`[workbench] node drop: ${type} at`, position);
  };

  const handleConfigChange = (_nodeId: string, _key: string, _value: unknown) => {
    // Node config mutations go through the runtime (authoritative);
    // the projection-side inspector reflects runtime state after refresh.
  };

  // Simple mode: handle template selection
  const handleSelectTemplate = useCallback((template: Template) => {
    setSelectedTemplate(template);
    setShowTemplateGallery(false);
    setShowSetupWizard(true);
  }, []);

  const handleCreateNew = useCallback(() => {
    setShowTemplateGallery(false);
    setShowSetupWizard(true);
    setSelectedTemplate(null);
  }, []);

  // Simple mode: handle wizard completion
  const handleWizardComplete = useCallback(async (draft: TemplateDraft) => {
    // Convert previewGraph nodes to workflow tasks and run via /api/nodes/run
    for (const node of draft.previewGraph.nodes) {
      try {
        await fetch("/api/nodes/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            nodeId: node.id,
            title: node.label,
            workflowNodeId: node.id,
          }),
        });
      } catch (err) {
        console.error(`Failed to run node ${node.id}:`, err);
      }
    }
    // Reset wizard state
    setShowSetupWizard(false);
    setShowTemplateGallery(true);
    setSelectedTemplate(null);
    // Refresh to show new tasks
    void refresh();
  }, [refresh]);

  const handleWizardCancel = useCallback(() => {
    setShowSetupWizard(false);
    setShowTemplateGallery(true);
    setSelectedTemplate(null);
  }, []);

  const snapshot = state.snapshot;
  const runningSession = state.sessions.find((s) => s.status === "running");
  const sessions: Session[] = snapshot?.sessions ?? [];

  // Simple mode content
  const simpleContent = (
    <>
      {/* ── Template Gallery / Setup Wizard ────────────────────── */}
      <div className="wb-simple-content">
        {showTemplateGallery && (
          <TemplateGallery
            onSelectTemplate={handleSelectTemplate}
            onCreateNew={handleCreateNew}
            mode={mode}
          />
        )}
        {showSetupWizard && selectedTemplate && (
          <SetupWizard
            template={{
              ...selectedTemplate,
              parameters: getTemplateParameters(selectedTemplate),
            }}
            onComplete={handleWizardComplete}
            onCancel={handleWizardCancel}
          />
        )}
        {showSetupWizard && !selectedTemplate && (
          <div className="wb-wizard-empty">
            <p>Custom workflow creation coming soon.</p>
            <button className="wb-btn wb-btn--primary" onClick={handleWizardCancel}>
              Back to Templates
            </button>
          </div>
        )}
      </div>

      {/* ── Bottom: console ──────────────────────────────── */}
      <ConsolePanel events={state.events} />

      {/* Direct session controls ────────────────────────── */}
      {runningSession && (
        <div className="wb-session-ctl">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void send()}
            placeholder="input to running session"
            aria-label="Session input"
          />
          <button className="wb-btn wb-btn--primary" onClick={() => void send()} disabled={!runningSession}>
            Send
          </button>
          <button className="wb-btn wb-btn--danger" onClick={() => void interrupt()} disabled={!runningSession}>
            Interrupt
          </button>
        </div>
      )}
    </>
  );

  // Power mode content
  const powerContent = (
    <>
      {/* ── Power Mode: task & session overview strip ────── */}
      {snapshot && (
        <div className="wb-task-overview">
          <div className="wb-task-overview__title">Tasks & Sessions</div>
          {snapshot.tasks.map((task) => (
            <div key={task.id} className="wb-task-overview__row">
              <span className={`wb-status-dot wb-status-dot--${task.status}`} />
              <span className="wb-task-overview__status">{task.status}</span>
              <span className="wb-task-overview__title-text">{task.title}</span>
              <span className="wb-task-overview__assignee">{task.assignedTo ?? "unassigned"}</span>
            </div>
          ))}
          {snapshot.tasks.length === 0 && <p className="wb-task-overview__empty">No tasks yet.</p>}
          <div className="wb-task-overview__sessions">
            {state.sessions.map((session) => (
              <div key={session.id} className="wb-task-overview__row">
                <span className={`wb-status-dot wb-status-dot--${session.status}`} />
                <span className="wb-task-overview__status">{session.status}</span>
                <span className="wb-task-overview__assignee">pid {session.pid}</span>
                <span className="wb-task-overview__mono">{session.id.slice(0, 8)}</span>
              </div>
            ))}
            {state.sessions.length === 0 && <p className="wb-task-overview__empty">No sessions.</p>}
          </div>
        </div>
      )}

      {/* ── Power Mode: tabbed bottom panels ─────────────── */}
      <div className="wb-power-panels" role="region" aria-label="Power mode panels">
        <div className="wb-power-panels__tabs" role="tablist">
          <button
            role="tab"
            aria-selected={powerTabs === "logs"}
            className={`wb-power-panels__tab ${powerTabs === "logs" ? "wb-power-panels__tab--active" : ""}`}
            onClick={() => setPowerTabs("logs")}
          >
            Logs
          </button>
          <button
            role="tab"
            aria-selected={powerTabs === "terminals"}
            className={`wb-power-panels__tab ${powerTabs === "terminals" ? "wb-power-panels__tab--active" : ""}`}
            onClick={() => setPowerTabs("terminals")}
          >
            Terminals
          </button>
          <button
            role="tab"
            aria-selected={powerTabs === "context"}
            className={`wb-power-panels__tab ${powerTabs === "context" ? "wb-power-panels__tab--active" : ""}`}
            onClick={() => setPowerTabs("context")}
          >
            Context Bus
          </button>
          <button
            role="tab"
            aria-selected={powerTabs === "inspector"}
            className={`wb-power-panels__tab ${powerTabs === "inspector" ? "wb-power-panels__tab--active" : ""}`}
            onClick={() => setPowerTabs("inspector")}
          >
            Wide Inspector
          </button>
        </div>

        <div className="wb-power-panels__content">
          {powerTabs === "logs" && (
            <LogsPanel selectedNodeId={selectedNode?.taskId ?? null} selectedSessionId={selectedSessionId} />
          )}
          {powerTabs === "terminals" && (
            <TerminalPanes
              sessions={sessions}
              onSessionSelect={setSelectedSessionId}
              selectedSessionId={selectedSessionId}
            />
          )}
          {powerTabs === "context" && (
            <ContextBusPanel
              selectedNode={selectedNode}
              snapshotTasks={snapshot?.tasks ?? []}
              snapshotArtifacts={snapshot?.artifacts ?? []}
              snapshotDecisions={snapshot?.decisions ?? []}
              snapshotEvents={state.events}
            />
          )}
          {powerTabs === "inspector" && <WideInspector selectedNode={selectedNode} />}
        </div>
      </div>
    </>
  );

  return (
    <div className="wb-workbench" data-mode={mode}>
      {/* ── Toolbar ─────────────────────────────────────────── */}
      <header className="wb-toolbar">
        <div className="wb-toolbar__brand">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="12" r="9" />
            <path d="M7.5 9.5a4.5 4.5 0 0 1 9 0c0 2-1.2 3.2-2.5 4.2V16h-4v-2.3c-1.3-1-2.5-2.2-2.5-4.2z" />
            <path d="M10 19h4" />
          </svg>
          <span>Chef</span>
        </div>

        <div className="wb-toolbar__actions">
          <button
            className="wb-toolbar__mode-toggle"
            onClick={() => setMode((m) => (m === "simple" ? "power" : "simple"))}
            aria-pressed={mode === "power"}
            title={mode === "simple" ? "Switch to Power Mode" : "Switch to Simple Mode"}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
            </svg>
            {mode === "simple" ? "Power Mode" : "Simple Mode"}
          </button>
          {runningSession && (
            <span
              className="wb-inspector__status wb-inspector__status--running"
              title={`Session ${runningSession.id.slice(0, 8)} · pid ${runningSession.pid}`}
            >
              ● {runningSession.status}
            </span>
          )}
        </div>
      </header>

      {/* ── Left: navigation + node library ────────────────── */}
      <NavigationPanel onDragStart={() => {}} />

      {/* ── Center: canvas ─────────────────────────────────── */}
      <main className="wb-canvas" role="main">
        <CanvasPanel refreshTick={refreshTick} onSelectNode={setSelectedNode} onDropNode={handleDropNode} />
      </main>

      {/* ── Right: inspector ───────────────────────────────── */}
      <aside className="wb-inspector" aria-label="Node inspector">
        <div className="wb-inspector__header">
          <h2 className="wb-inspector__title">Inspector</h2>
        </div>
        <InspectorPanel {...inspectorProps(selectedNode, mode, handleConfigChange)} />
      </aside>

      {/* ── Bottom: mode-specific content ──────────────────── */}
      {mode === "simple" ? simpleContent : powerContent}
    </div>
  );
}