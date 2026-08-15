import { useEffect, useState, useCallback } from "react";
import type { RuntimeEvent, WorkspaceSnapshot } from "../../src/core/types.ts";
import type { GraphNode } from "../../src/core/graph.ts";
import { CanvasPanel } from "./CanvasPanel.tsx";
import { NavigationPanel } from "./NavigationPanel.tsx";
import { InspectorPanel } from "./InspectorPanel.tsx";
import { ConsolePanel } from "./ConsolePanel.tsx";
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

export function App() {
  const [state, setState] = useState<DashboardState>({ snapshot: null, events: [], sessions: [] });
  const [input, setInput] = useState("");
  const [refreshTick, setRefreshTick] = useState(0);
  const [mode, setMode] = useState<Mode>("simple");
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);

  // Keep the mode visible to CSS for theming.
  useEffect(() => {
    document.documentElement.dataset.mode = mode;
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
    // Projection-side placeholder: the runtime builds the real graph.
    // A future "add node" API will land here.
    console.info(`[workbench] node drop: ${type} at`, position);
  };

  const snapshot = state.snapshot;
  const runningSession = state.sessions.find((s) => s.status === "running");

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
        <InspectorPanel
          selectedNode={selectedNode}
          onAcceptApproval={(node) => {
            const approvalId = node.config.approvalId as string | undefined;
            if (!approvalId) return;
            void fetch(`/api/approvals/${approvalId}/accept`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ approver: "dashboard" }),
            });
          }}
          onRejectApproval={(node) => {
            const approvalId = node.config.approvalId as string | undefined;
            if (!approvalId) return;
            void fetch(`/api/approvals/${approvalId}/reject`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ approver: "dashboard" }),
            });
          }}
        />
      </aside>

      {/* ── Bottom: console ────────────────────────────────── */}
      <ConsolePanel events={state.events} />

      {/* ── Power Mode overlay: direct session controls ────── */}
      {mode === "power" && (
        <div
          style={{
            position: "fixed",
            bottom: "var(--console-height)",
            right: 0,
            zIndex: "var(--z-dropdown)",
            display: "flex",
            gap: 8,
            padding: "8px 12px",
            background: "var(--bg-surface)",
            border: "1px solid var(--border-subtle)",
            borderBottom: "none",
            borderRadius: "8px 0 0 0",
            boxShadow: "var(--shadow-md)",
          }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void send()}
            placeholder="input to running session"
            aria-label="Session input"
            style={{
              flex: 1,
              minWidth: 220,
              background: "var(--bg-base)",
              color: "var(--fg-primary)",
              border: "1px solid var(--border-subtle)",
              borderRadius: 6,
              padding: "6px 8px",
              fontSize: 13,
            }}
          />
          <button className="wb-btn wb-btn--primary" onClick={() => void send()} disabled={!runningSession}>
            Send
          </button>
          <button className="wb-btn wb-btn--danger" onClick={() => void interrupt()} disabled={!runningSession}>
            Interrupt
          </button>
        </div>
      )}

      {/* ── Power Mode: task & session overview strip ───────── */}
      {mode === "power" && snapshot && (
        <div
          style={{
            position: "fixed",
            right: 0,
            bottom: "calc(var(--console-height) + 52px)",
            zIndex: "var(--z-dropdown)",
            width: 340,
            maxHeight: 220,
            overflowY: "auto",
            padding: 12,
            background: "var(--bg-surface)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "8px 0 0 8px",
            boxShadow: "var(--shadow-md)",
            fontSize: 13,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 8, textTransform: "uppercase", fontSize: 11, letterSpacing: "0.05em", color: "var(--fg-secondary)" }}>
            Tasks & Sessions
          </div>
          {snapshot.tasks.map((task) => (
            <div key={task.id} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
              <span className={`wb-status-dot wb-status-dot--${task.status}`} />
              <span style={{ fontWeight: 600 }}>{task.status}</span>
              <span style={{ color: "var(--fg-secondary)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {task.title}
              </span>
              <span style={{ color: "var(--fg-muted)", fontSize: 12 }}>{task.assignedTo ?? "unassigned"}</span>
            </div>
          ))}
          {snapshot.tasks.length === 0 && <p style={{ color: "var(--fg-muted)", margin: 0 }}>No tasks yet.</p>}
          <div style={{ borderTop: "1px solid var(--border-subtle)", margin: "8px 0", paddingTop: 8 }}>
            {state.sessions.map((session) => (
              <div key={session.id} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4, fontSize: 12 }}>
                <span className={`wb-status-dot wb-status-dot--${session.status}`} />
                <span style={{ fontWeight: 600 }}>{session.status}</span>
                <span style={{ color: "var(--fg-muted)" }}>pid {session.pid}</span>
                <span style={{ color: "var(--fg-muted)", fontFamily: "monospace" }}>{session.id.slice(0, 8)}</span>
              </div>
            ))}
            {state.sessions.length === 0 && <p style={{ color: "var(--fg-muted)", margin: 0 }}>No sessions.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
