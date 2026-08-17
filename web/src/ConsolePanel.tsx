import { useEffect, useRef, useState } from "react";
import type {
  Approval,
  Artifact,
  RuntimeEvent,
  Task,
  TaskStatus,
  WorkspaceSnapshot,
} from "../../src/core/types.ts";
import { NodeIcon } from "./nodeCatalog.tsx";
import { TerminalPanel } from "./TerminalPanel.tsx";
import { api } from "./api";

interface ChatMessageView {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

interface ChatEventPayload {
  content?: string;
  error?: string;
  goal?: string;
  planId?: string;
  status?: string;
  taskIds?: string[];
  taskCount?: number;
  ok?: boolean;
}

/** Snapshot supplied by the workbench shell (App.tsx); may be null before first refresh. */
export interface ConsoleSnapshot {
  snapshot: WorkspaceSnapshot | null;
  sessions: Array<{ id: string; taskId: string; status: string; pid: number }>;
}

export interface ConsoleMetrics {
  liveSessions: number;
  tasksByStatus: Partial<Record<TaskStatus, number>>;
  artifacts: number;
  cost: number | null;
  tokens: number | null;
  elapsedMs: number | null;
}
export type ConsoleTab = "timeline" | "artifacts" | "blockers" | "events" | "chat" | "terminal" | "peers";

const TABS: Array<{ id: ConsoleTab; label: string }> = [
  { id: "timeline", label: "Timeline" },
  { id: "artifacts", label: "Artifacts" },
  { id: "blockers", label: "Blockers" },
  { id: "events", label: "Events" },
  { id: "chat", label: "Chat" },
  { id: "terminal", label: "Terminal" },
  { id: "peers", label: "Peers" },
];

// ---------------------------------------------------------------------------
// Chat plumbing (unchanged from Phase 6)
// ---------------------------------------------------------------------------

function payloadContent(event: RuntimeEvent): string | null {
  const payload = event.payload as ChatEventPayload | undefined;
  if (event.type === "chat.assistant" && payload?.content) return payload.content;
  if (event.type === "chat.plan.error" && payload?.error) return `Chef couldn't plan that: ${payload.error}`;
  if (event.type === "chat.plan.none" && payload?.goal) {
    return `I couldn't turn "${payload.goal}" into a plan yet. Try rephrasing with a clearer goal.`;
  }
  if (event.type === "chat.plan.proposed" && payload?.planId) {
    return `Plan proposed (${payload.taskCount ?? 0} tasks). Validating and running…`;
  }
  if (event.type === "chat.plan.applied" && payload?.status === "completed") {
    return "Plan applied successfully.";
  }
  if (event.type === "chat.plan.applied" && payload?.status === "failed") {
    return `Plan failed: ${payload.error ?? "unknown error"}`;
  }
  return null;
}

function isAssistantTerminal(event: RuntimeEvent): boolean {
  return event.type === "chat.assistant" || event.type === "chat.plan.error" || event.type === "chat.plan.none";
}

// ---------------------------------------------------------------------------
// Execution console helpers
// ---------------------------------------------------------------------------

/** Event types that carry live node output (feed the progress indicator). */
function isLiveOutput(event: RuntimeEvent): boolean {
  return event.type === "session.data" || event.type.startsWith("task.") || event.type === "session.crash";
}

const TERMINAL_TASKS: ReadonlySet<TaskStatus> = new Set(["completed", "failed", "cancelled"]);

/** Latest task snapshot plus timing derived from the event log (duration while running). */
interface TaskRow {
  task: Task;
  startedAt: number | null;
  durationMs: number | null;
  lastLiveAt: number;
  recentOutput: string[];
}

function summarizeTaskEvents(taskId: string, events: RuntimeEvent[]): TaskRow {
  let startedAt: number | null = null;
  let lastLiveAt = 0;
  const recentOutput: string[] = [];
  for (const event of events) {
    if (event.taskId !== taskId) continue;
    if (event.type === "task.started" && startedAt === null) startedAt = event.timestamp;
    if (isLiveOutput(event)) lastLiveAt = Math.max(lastLiveAt, event.timestamp);
    if (event.type === "session.data") {
      const data = (event.payload as { data?: string } | undefined)?.data;
      if (data) recentOutput.push(data);
    }
  }
  return { task: null as unknown as Task, startedAt, durationMs: null, lastLiveAt, recentOutput: recentOutput.slice(-4) };
}

/** Group a task's live output into <=8 compact lines (latest first). */
function compactOutput(rows: string[]): string[] {
  const lines: string[] = [];
  for (const chunk of rows) {
    for (const line of chunk.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      lines.push(trimmed.length > 160 ? `${trimmed.slice(0, 157)}…` : trimmed);
      if (lines.length >= 8) return lines;
    }
  }
  return lines;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

const ARTIFACT_ICONS: Record<string, string> = {
  file: "📄",
  document: "📃",
  code: "⌘",
  image: "🖼",
  research: "🔍",
  result: "✓",
};

const TASK_STATUS_ORDER: TaskStatus[] = ["running", "completed", "failed", "blocked", "pending", "assigned", "cancelled"];
const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  pending: "Waiting",
  assigned: "Assigned",
  running: "Running",
  blocked: "Blocked",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** Latest terminal status per task from the immutable event log (runtime-authoritative). */
function statusFromEvents(taskId: string, events: RuntimeEvent[]): TaskStatus | null {
  let status: TaskStatus | null = null;
  for (const event of events) {
    if (event.taskId !== taskId || !event.type.startsWith("task.")) continue;
    const to = (event.payload as { to?: string } | undefined)?.to;
    if (event.type === "task.started") status = "running";
    else if (event.type === "task.completed") status = "completed";
    else if (event.type === "task.failed") status = "failed";
    else if (event.type === "task.cancelled") status = "cancelled";
    else if (event.type === "task.blocked") status = "blocked";
    else if (event.type === "task.assigned") status = "assigned";
    else if (event.type === "task.created") status = "pending";
    if (to && TERMINAL_TASKS.has(to as TaskStatus)) status = to as TaskStatus;
  }
  return status;
}

/** Event-log timing for a task: start time, terminal time, terminal status. */
function eventTiming(taskId: string, events: RuntimeEvent[]): { startedAt: number | null; endedAt: number | null; terminal: TaskStatus | null } {
  let startedAt: number | null = null;
  let endedAt: number | null = null;
  let terminal: TaskStatus | null = null;
  for (const event of events) {
    if (event.taskId !== taskId || !event.type.startsWith("task.")) continue;
    if (event.type === "task.started" && startedAt === null) startedAt = event.timestamp;
    if (event.type === "task.completed" || event.type === "task.failed" || event.type === "task.cancelled") {
      endedAt = event.timestamp;
      terminal = event.type === "task.completed" ? "completed" : event.type === "task.failed" ? "failed" : "cancelled";
    }
  }
  return { startedAt, endedAt, terminal };
}

// ---------------------------------------------------------------------------
// ConsolePanel
// ---------------------------------------------------------------------------

export function ConsolePanel({ events, snapshot, metrics }: { events: RuntimeEvent[]; snapshot: ConsoleSnapshot; metrics: ConsoleMetrics }) {
  const [activeTab, setActiveTab] = useState<ConsoleTab>("timeline");
  const [chatInput, setChatInput] = useState("");
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSeq, setLastSeq] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [expandedArtifacts, setExpandedArtifacts] = useState<Set<string>>(new Set());
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [artifactsError, setArtifactsError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<Set<string>>(new Set());
  const [approvalBusy, setApprovalBusy] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const [peerSessions, setPeerSessions] = useState<Array<{ id: string; taskId: string; status: string; pid: number }>>([]);
  const [peerSessionId, setPeerSessionId] = useState<string>("");
  const [peerFrom, setPeerFrom] = useState<string>("peer");
  const [peerText, setPeerText] = useState<string>("");
  const [peerLog, setPeerLog] = useState<Array<{ from: string; text: string; at: number; ok: boolean }>>([]);
  const [peerBusy, setPeerBusy] = useState(false);
  const [peerError, setPeerError] = useState<string | null>(null);
  const messagesRef = useRef<ChatMessageView[]>([]);
  const streamRef = useRef<EventSource | null>(null);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Track the max event seq for replay.
  useEffect(() => {
    setLastSeq((prev) => Math.max(prev, ...events.map((e) => e.seq)));
  }, [events]);

  // Clock tick so running-node durations and elapsed metrics update live.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Load persisted chat history on mount.
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/chat/messages");
        if (!res.ok) throw new Error(`history ${res.status}`);
        const data = (await res.json()) as {
          ok: boolean;
          data: Array<{ from: string; to: string; payload: { content?: string }; timestamp: number }>;
        };
        const history: ChatMessageView[] = data.data.map((m) => ({
          role: m.from === "user" ? "user" : "assistant",
          content: m.payload?.content ?? "",
          timestamp: m.timestamp,
        }));
        setMessages(history);
      } catch (err) {
        console.warn("[chat] failed to load history:", err);
      }
    })();
  }, []);

  // Load artifact cards from the inspector endpoint on mount and whenever the
  // snapshot's artifact count changes (runtime-authoritative projection).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/inspector/artifacts");
        if (!res.ok) throw new Error(`artifacts ${res.status}`);
        const data = (await res.json()) as { ok: boolean; data: Artifact[] };
        if (!cancelled) {
          setArtifacts(data.data);
          setArtifactsError(null);
        }
      } catch (err) {
        if (!cancelled) setArtifactsError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [snapshot.snapshot?.artifacts.length]);

  // Load available sessions for peer messaging when snapshot changes.
  useEffect(() => {
    const sessionList = snapshot.sessions ?? [];
    if (sessionList.length > 0) {
      setPeerSessions(sessionList);
      if (!peerSessionId && sessionList[0]) {
        setPeerSessionId(sessionList[0].id);
      }
    }
  }, [snapshot.sessions, peerSessionId]);

  // Subscribe to the chat SSE stream; replays from the last seen seq.
  useEffect(() => {
    const es = new EventSource(`/api/chat/stream?afterSeq=${lastSeq}`);
    streamRef.current = es;
    let pendingAssistant: ChatMessageView | null = null;

    es.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data) as RuntimeEvent;
        setLastSeq(event.seq);
        const content = payloadContent(event);
        if (content === null) return;

        if (isAssistantTerminal(event)) {
          // Close out any streaming assistant bubble.
          if (pendingAssistant) {
            const merged = {
              role: "assistant" as const,
              content:
                event.type === "chat.assistant"
                  ? content
                  : `${pendingAssistant.content}\n${content}`,
              timestamp: pendingAssistant.timestamp,
            };
            setMessages((prev) => [
              ...prev.filter((m) => m !== pendingAssistant),
              merged,
            ]);
            pendingAssistant = null;
            setStreaming(false);
          } else {
            const finalMsg: ChatMessageView = { role: "assistant", content, timestamp: event.timestamp };
            setMessages((prev) => [...prev, finalMsg]);
            setStreaming(false);
          }
          return;
        }

        // Streaming progress (plan proposed / applied): accumulate into the
        // current assistant bubble if one is open, otherwise start one.
        if (!pendingAssistant) {
          const fresh: ChatMessageView = { role: "assistant", content, timestamp: event.timestamp };
          pendingAssistant = fresh;
          setStreaming(true);
          setMessages((prev) => [...prev, fresh]);
        } else {
          const updated: ChatMessageView = {
            ...pendingAssistant,
            content: `${pendingAssistant.content}\n${content}`,
          };
          pendingAssistant = updated;
          setMessages((prev) => prev.map((m) => (m === updated ? updated : m)));
        }
      } catch {
        // Ignore malformed frames.
      }
    };
    es.onerror = () => {
      // EventSource auto-reconnects; surface a subtle status.
      setError("Connection to Chef chat interrupted — reconnecting…");
    };

    return () => {
      es.close();
      streamRef.current = null;
    };
  }, [lastSeq]);

  const sendChat = async () => {
    const text = chatInput.trim();
    if (!text || streaming) return;
    const userMsg: ChatMessageView = { role: "user", content: text, timestamp: Date.now() };
    setMessages((prev) => [...prev, userMsg]);
    setChatInput("");
    setError(null);
    setStreaming(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `chat request failed (${res.status})`);
      }
      const data = (await res.json()) as { ok: boolean; data: { report: string; ok: boolean } };
      // If the SSE stream already rendered the assistant reply, don't duplicate.
      const hasAssistant = messagesRef.current.some((m) => m.role === "assistant" && m.content === data.data.report);
      if (!hasAssistant) {
        setMessages((prev) => [...prev, { role: "assistant", content: data.data.report, timestamp: Date.now() }]);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setMessages((prev) => [...prev, { role: "assistant", content: `Something went wrong: ${detail}`, timestamp: Date.now() }]);
      setError(detail);
    } finally {
      setStreaming(false);
    }
  };

  const cancelChat = () => {
    streamRef.current?.close();
    setStreaming(false);
  };
  // Peer messaging actions — send a message envelope to a selected session
  // and reflect the result locally.
  const sendPeerMessage = async () => {
    const text = peerText.trim();
    if (!text || !peerSessionId) return;
    setPeerBusy(true);
    setPeerError(null);
    const pending = { from: peerFrom, text, at: Date.now(), ok: false };
    setPeerLog((prev) => [...prev, pending]);
    try {
      await api.sendPeerMessage(peerSessionId, peerFrom, text);
      setPeerLog((prev) => prev.map((m) => (m === pending ? { ...pending, ok: true } : m)));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setPeerError(detail);
      setPeerLog((prev) => prev.map((m) => (m === pending ? { ...pending, ok: false } : m)));
    } finally {
      setPeerBusy(false);
      setPeerText("");
    }
  };

  // -------------------------------------------------------------------------
  // Execution console actions (all go through runtime APIs)
  // -------------------------------------------------------------------------

  const retryTask = async (taskId: string) => {
    setActionError(null);
    setRetrying((prev) => new Set(prev).add(taskId));
    try {
      const res = await fetch(`/api/nodes/${taskId}/retry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `retry failed (${res.status})`);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setRetrying((prev) => {
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
    }
  };

  const resolveApproval = async (approvalId: string, decision: "accept" | "reject") => {
    setActionError(null);
    setApprovalBusy((prev) => new Set(prev).add(approvalId));
    try {
      const res = await fetch(`/api/approvals/${approvalId}/${decision}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approver: "console" }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `approval ${decision} failed (${res.status})`);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setApprovalBusy((prev) => {
        const next = new Set(prev);
        next.delete(approvalId);
        return next;
      });
    }
  };

  // -------------------------------------------------------------------------
  // Derived execution views (runtime-authoritative projections)
  // -------------------------------------------------------------------------

  const { snapshot: ws } = snapshot;
  const tasks: Task[] = ws?.tasks ?? [];
  const approvals: Approval[] = ws?.approvals ?? [];
  const pendingApprovals = approvals.filter((a) => a.status === "pending");
  const approvalIds = new Set(approvals.map((a) => a.id));

  // Timeline rows: one per task, status from the event log overrides the
  // snapshot when the log shows a newer terminal state.
  const timeline = tasks
    .map((task) => {
      const logStatus = statusFromEvents(task.id, events);
      const timing = eventTiming(task.id, events);
      const status: TaskStatus =
        logStatus && (logStatus !== "running" || !TERMINAL_TASKS.has(task.status)) ? logStatus : task.status;
      const durationMs =
        timing.endedAt !== null && timing.startedAt !== null
          ? timing.endedAt - timing.startedAt
          : status === "running" && timing.startedAt !== null
            ? now - timing.startedAt
            : null;
      const lastLiveAt = events
        .filter((e) => e.taskId === task.id && isLiveOutput(e))
        .reduce((max, e) => Math.max(max, e.timestamp), 0);
      return { task, status, startedAt: timing.startedAt, durationMs, lastLiveAt };
    })
    .sort((a, b) => {
      const rank: Record<TaskStatus, number> = { running: 0, blocked: 1, failed: 2, pending: 3, assigned: 4, completed: 5, cancelled: 6 };
      return rank[a.status] - rank[b.status] || a.task.createdAt - b.task.createdAt;
    });

  const running = timeline.filter((row) => row.status === "running").length;
  const failedCount = timeline.filter((row) => row.status === "failed").length;

  // Blockers summary: pending approvals + tasks waiting on them, plus tasks
  // with unresolved dependencies that keep them pending.
  const blockedTasks = tasks.filter((t) => t.status === "blocked");
  const pendingApprovalTaskIds = new Set(pendingApprovals.map((a) => a.taskId));
  const waitingTasks = tasks.filter(
    (t) =>
      (t.status === "pending" || t.status === "assigned") &&
      t.dependencies.some((dep) => {
        const depTask = tasks.find((x) => x.id === dep);
        return depTask === undefined || depTask.status !== "completed";
      }),
  );

  // Metrics strip (App.tsx supplies computed values; missing = "unknown").
  const metricCells: Array<{ label: string; value: string }> = [
    { label: "Live sessions", value: String(metrics.liveSessions) },
    { label: "Running", value: String(running) },
    { label: "Completed", value: String(metrics.tasksByStatus.completed ?? 0) },
    { label: "Failed", value: String(failedCount) },
    { label: "Artifacts", value: String(metrics.artifacts) },
    { label: "Cost", value: metrics.cost === null ? "unknown" : `$${metrics.cost.toFixed(2)}` },
    { label: "Tokens", value: metrics.tokens === null ? "unknown" : String(metrics.tokens) },
    { label: "Elapsed", value: metrics.elapsedMs === null ? "unknown" : formatDuration(metrics.elapsedMs) },
  ];

  const eventColors: Record<string, string> = {
    "task.created": "var(--accent-blue)",
    "task.assigned": "var(--accent-blue)",
    "task.started": "var(--accent-green)",
    "task.completed": "var(--accent-blue)",
    "task.failed": "var(--accent-red)",
    "task.cancelled": "var(--fg-muted)",
    "task.blocked": "var(--accent-gold)",
    "session.spawned": "var(--accent-purple)",
    "session.data": "var(--fg-secondary)",
    "session.exit": "var(--accent-gold)",
    "session.crash": "var(--accent-red)",
    "plan.proposed": "var(--accent-purple)",
    "plan.approved": "var(--accent-green)",
    "approval.requested": "var(--accent-purple)",
    "approval.resolved": "var(--accent-green)",
    "artifact.created": "var(--accent-blue)",
  };

  return (
    <div className="wb-console" role="region" aria-label="Console">
      <header className="wb-console__header">
        <h3 className="wb-console__title">Console</h3>
        <div className="wb-console__tabs" role="tablist">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              className={`wb-console__tab ${activeTab === tab.id ? "wb-console__tab--active" : ""}`}
              role="tab"
              aria-selected={activeTab === tab.id}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
              {tab.id === "blockers" && pendingApprovals.length > 0 && (
                <span className="wb-console__tab-badge">{pendingApprovals.length}</span>
              )}
              {tab.id === "artifacts" && artifacts.length > 0 && (
                <span className="wb-console__tab-badge">{artifacts.length}</span>
              )}
            </button>
          ))}
        </div>
      </header>

      {/* ── Metrics strip ─────────────────────────────────────── */}
      <div className="wb-console__metrics" role="group" aria-label="Execution metrics">
        {metricCells.map((cell) => (
          <div key={cell.label} className="wb-console__metric">
            <span className="wb-console__metric-value">{cell.value}</span>
            <span className="wb-console__metric-label">{cell.label}</span>
          </div>
        ))}
      </div>

      {actionError && (
        <div className="wb-console__action-error" role="status">
          {actionError}
        </div>
      )}

      <div className="wb-console__content">
        {/* Timeline panel */}
        <div className={`wb-console__panel ${activeTab === "timeline" ? "wb-console__panel--active" : ""}`} role="tabpanel">
          {timeline.length === 0 ? (
            <p className="wb-console__empty">No nodes executed yet. Run a workflow and watch it here.</p>
          ) : (
            <ol className="wb-console__timeline">
              {timeline.map(({ task, status, startedAt, durationMs, lastLiveAt }) => {
                const recentOutput = compactOutput(summarizeTaskEvents(task.id, events).recentOutput);
                const failed = status === "failed";
                const liveNow = status === "running";
                return (
                  <li key={task.id} className={`wb-console__timeline-row wb-console__timeline-row--${status}`}>
                    <span className={`wb-console__dot wb-console__dot--${status}`} aria-hidden />
                    <div className="wb-console__timeline-main">
                      <div className="wb-console__timeline-head">
                        <span className="wb-console__timeline-name">{task.title}</span>
                        <span className="wb-console__timeline-status">{TASK_STATUS_LABEL[status]}</span>
                        {durationMs !== null && (
                          <span className="wb-console__timeline-duration">{formatDuration(durationMs)}</span>
                        )}
                        </div>
                      {liveNow && (
                        <div className="wb-console__progress" role="progressbar" aria-label={`${task.title} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={100}>
                          <div className="wb-console__progress-indeterminate" />
                        </div>
                      )}
                      {failed && task.error && (
                        <div className="wb-console__error">
                          <span className="wb-console__error-message">{task.error}</span>
                          <span className="wb-console__replan-hint">Tip: check node inputs, then retry or replan from the canvas.</span>
                        </div>
                      )}
                      {failed && (
                        <div className="wb-console__error-actions">
                          <button
                            className="wb-btn wb-btn--primary wb-btn--sm"
                            onClick={() => void retryTask(task.id)}
                            disabled={retrying.has(task.id)}
                          >
                            {retrying.has(task.id) ? "Retrying…" : "Retry"}
                          </button>
                        </div>
                      )}
                      {task.status === "blocked" && !approvalIds.has(task.approvalId ?? "") && (
                        <div className="wb-console__blocked-note">Blocked — waiting on a dependency or external condition.</div>
                      )}
                      {recentOutput.length > 0 && (
                        <details className="wb-console__output" open={liveNow}>
                          <summary>{liveNow ? "live output" : "output"}</summary>
                          {recentOutput.map((line, idx) => (
                            <div key={idx} className="wb-console__output-line">{line}</div>
                          ))}
                        </details>
                      )}
                    </div>
                    <div className="wb-console__timeline-meta">
                      {startedAt !== null && <span className="wb-console__timeline-time">{formatTime(startedAt)}</span>}
                      {liveNow && lastLiveAt > 0 && <span className="wb-console__timeline-live">● live</span>}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>

        {/* Artifacts panel */}
        <div className={`wb-console__panel ${activeTab === "artifacts" ? "wb-console__panel--active" : ""}`} role="tabpanel">
          {artifactsError ? (
            <p className="wb-console__empty">Could not load artifacts: {artifactsError}</p>
          ) : artifacts.length === 0 ? (
            <p className="wb-console__empty">No artifacts yet. Completed nodes publish results here.</p>
          ) : (
            <ul className="wb-console__artifacts">
              {artifacts.slice().reverse().map((artifact) => {
                const expanded = expandedArtifacts.has(artifact.id);
                const preview = artifact.metadata?.content;
                const previewText =
                  typeof preview === "string"
                    ? preview
                    : typeof preview === "object" && preview !== null
                      ? JSON.stringify(preview, null, 2)
                      : null;
                return (
                  <li key={artifact.id} className="wb-console__artifact">
                    <div className="wb-console__artifact-icon" aria-hidden>
                      {ARTIFACT_ICONS[artifact.type] ?? "📦"}
                    </div>
                    <div className="wb-console__artifact-info">
                      <div className="wb-console__artifact-head">
                        <span className="wb-console__artifact-name">{artifact.name}</span>
                        <span className="wb-console__artifact-type">{artifact.type}</span>
                        <span className="wb-console__artifact-version">v{artifact.version}</span>
                      </div>
                      <div className="wb-console__artifact-meta">
                        by {artifact.createdBy}
                        {artifact.taskId ? ` · task ${artifact.taskId.slice(0, 8)}` : ""}
                        {artifact.uri ? ` · ${artifact.uri}` : ""}
                      </div>
                      <div className="wb-console__artifact-actions">
                        <button
                          className="wb-btn wb-btn--ghost wb-btn--sm"
                          onClick={() => {
                            setExpandedArtifacts((prev) => {
                              const next = new Set(prev);
                              if (next.has(artifact.id)) next.delete(artifact.id);
                              else next.add(artifact.id);
                              return next;
                            });
                          }}
                        >
                          {expanded ? "Hide preview" : "Preview"}
                        </button>
                        <a
                          className="wb-btn wb-btn--ghost wb-btn--sm"
                          href={artifact.uri}
                          target="_blank"
                          rel="noreferrer"
                          download={artifact.name}
                        >
                          Download
                        </a>
                        <button
                          className="wb-btn wb-btn--ghost wb-btn--sm"
                          onClick={() => {
                            void navigator.clipboard?.writeText(artifact.uri).catch(() => undefined);
                          }}
                        >
                          Share
                        </button>
                      </div>
                      {expanded && previewText !== null && (
                        <pre className="wb-console__artifact-preview">{previewText}</pre>
                      )}
                      {expanded && previewText === null && (
                        <p className="wb-console__artifact-preview wb-console__artifact-preview--empty">
                          No preview available for this artifact.
                        </p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Blockers panel */}
        <div className={`wb-console__panel ${activeTab === "blockers" ? "wb-console__panel--active" : ""}`} role="tabpanel">
          {pendingApprovals.length === 0 && blockedTasks.length === 0 && waitingTasks.length === 0 ? (
            <p className="wb-console__empty">No blockers. All clear.</p>
          ) : (
            <div className="wb-console__blockers">
              {pendingApprovals.length > 0 && (
                <section className="wb-console__blocker-section">
                  <h4 className="wb-console__blocker-heading">Pending approvals ({pendingApprovals.length})</h4>
                  <ul className="wb-console__approval-list">
                    {pendingApprovals.map((approval) => {
                      const linkedTask = tasks.find((t) => t.id === approval.taskId);
                      const busy = approvalBusy.has(approval.id);
                      return (
                        <li key={approval.id} className="wb-console__approval">
                          <div className="wb-console__approval-info">
                            <span className="wb-console__approval-title">{linkedTask?.title ?? "Task"}</span>
                            <span className="wb-console__approval-reason">{approval.reason}</span>
                          </div>
                          <div className="wb-console__approval-actions">
                            <button
                              className="wb-btn wb-btn--primary wb-btn--sm"
                              onClick={() => void resolveApproval(approval.id, "accept")}
                              disabled={busy}
                            >
                              Accept
                            </button>
                            <button
                              className="wb-btn wb-btn--danger wb-btn--sm"
                              onClick={() => void resolveApproval(approval.id, "reject")}
                              disabled={busy}
                            >
                              Reject
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}
              {blockedTasks.filter((t) => !pendingApprovalTaskIds.has(t.id)).length > 0 && (
                <section className="wb-console__blocker-section">
                  <h4 className="wb-console__blocker-heading">Blocked tasks</h4>
                  <ul className="wb-console__blocked-list">
                    {blockedTasks
                      .filter((t) => !pendingApprovalTaskIds.has(t.id))
                      .map((task) => (
                        <li key={task.id} className="wb-console__blocked-item">
                          <span className="wb-console__blocked-title">{task.title}</span>
                          <span className="wb-console__blocked-reason">{task.error ?? "blocked"}</span>
                          {task.status === "blocked" && (
                            <button
                              className="wb-btn wb-btn--ghost wb-btn--sm"
                              onClick={() => void retryTask(task.id)}
                              disabled={retrying.has(task.id)}
                            >
                              {retrying.has(task.id) ? "Retrying…" : "Retry"}
                            </button>
                          )}
                        </li>
                      ))}
                  </ul>
                </section>
              )}
              {waitingTasks.length > 0 && (
                <section className="wb-console__blocker-section">
                  <h4 className="wb-console__blocker-heading">Waiting on dependencies ({waitingTasks.length})</h4>
                  <ul className="wb-console__blocked-list">
                    {waitingTasks.map((task) => (
                      <li key={task.id} className="wb-console__blocked-item">
                        <span className="wb-console__blocked-title">{task.title}</span>
                        <span className="wb-console__blocked-reason">
                          waiting for:{" "}
                          {task.dependencies
                            .map((dep) => {
                              const depTask = tasks.find((t) => t.id === dep);
                              return depTask ? depTask.title : dep.slice(0, 8);
                            })
                            .join(", ")}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}
        </div>

        {/* Events panel */}
        <div className={`wb-console__panel ${activeTab === "events" ? "wb-console__panel--active" : ""}`} role="tabpanel">
          {events.length === 0 ? (
            <p className="wb-console__empty">No events yet.</p>
          ) : (
            events.slice().reverse().map((event) => (
              <div key={event.id} className="wb-console__event">
                <span className="wb-console__event-seq">#{event.seq}</span>
                <span
                  className="wb-console__event-type"
                  style={{ color: eventColors[event.type] ?? "var(--fg-secondary)" }}
                >
                  {event.type}
                </span>
                <span className="wb-console__event-payload">{JSON.stringify(event.payload)}</span>
              </div>
            ))
          )}
        </div>

        {/* Chat panel */}
        <div className={`wb-console__panel ${activeTab === "chat" ? "wb-console__panel--active" : ""}`} role="tabpanel">
          <div className="wb-console__chat">
            <div className="wb-console__messages" role="log" aria-live="polite">
              {messages.length === 0 && (
                <div className="wb-console__chat-empty">
                  <NodeIcon category="Agents" size={32} />
                  <p>Chat with Chef</p>
                  <p className="wb-console__chat-hint">Describe a workflow and Chef will plan, validate, and run it.</p>
                </div>
              )}
              {messages.map((msg, idx) => (
                <div key={idx} className={`wb-console__message ${msg.role === "user" ? "wb-console__message--user" : "wb-console__message--assistant"}`}>
                  <div className="wb-console__message-avatar">{msg.role === "user" ? "U" : "C"}</div>
                  <div className="wb-console__message-content">{msg.content}</div>
                </div>
              ))}
              {streaming && (
                <div className="wb-console__message wb-console__message--assistant">
                  <div className="wb-console__message-avatar">C</div>
                  <div className="wb-console__message-content wb-console__message-content--streaming">
                    <span className="wb-console__typing-dot" />
                    <span className="wb-console__typing-dot" />
                    <span className="wb-console__typing-dot" />
                  </div>
                </div>
              )}
            </div>
            {error && (
              <div className="wb-console__chat-error" role="status">
                {error}
              </div>
            )}
            <form className="wb-console__input-form" onSubmit={(e) => { e.preventDefault(); void sendChat(); }}>
              <input
                className="wb-console__input"
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="Message Chef…"
                aria-label="Chat input"
                disabled={streaming}
              />
              <button type="submit" className="wb-btn wb-btn--primary" disabled={!chatInput.trim() || streaming}>
                Send
              </button>
              {streaming && (
                <button type="button" className="wb-btn wb-btn--danger" onClick={cancelChat}>
                  Stop
                </button>
              )}
            </form>
          </div>
        </div>

        {/* Terminal panel */}
        <div className={`wb-console__panel ${activeTab === "terminal" ? "wb-console__panel--active" : ""}`} role="tabpanel">
          <TerminalPanel />
        </div>

        {/* Peers panel — message_peer over canvas edges */}
        <div className={`wb-console__panel ${activeTab === "peers" ? "wb-console__panel--active" : ""}`} role="tabpanel">
          <div className="wb-console__peers">
            <div className="wb-console__peers-header">
              <h4>Send peer message</h4>
              <p className="wb-console__peers-hint">
                Dispatches an October-style <code>message_peer</code> envelope to the target session's inbox.
              </p>
            </div>

            {peerSessions.length === 0 ? (
              <p className="wb-console__empty">No live sessions. Start a task from the canvas to enable peer messaging.</p>
            ) : (
              <>
                <div className="wb-console__peers-select">
                  <label className="wb-console__peers-label">Session</label>
                  <select
                    className="wb-console__select"
                    value={peerSessionId}
                    onChange={(e) => setPeerSessionId(e.target.value)}
                  >
                    {peerSessions.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.id.slice(0, 8)}… (task {s.taskId.slice(0, 8)}, {s.status})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="wb-console__peers-select">
                  <label className="wb-console__peers-label">From (agent id)</label>
                  <input
                    className="wb-console__input"
                    type="text"
                    value={peerFrom}
                    onChange={(e) => setPeerFrom(e.target.value)}
                    placeholder="peer"
                  />
                </div>

                <div className="wb-console__peers-textarea">
                  <label className="wb-console__peers-label">Message</label>
                  <textarea
                    className="wb-console__textarea"
                    value={peerText}
                    onChange={(e) => setPeerText(e.target.value)}
                    placeholder="Type a message for the peer…"
                    rows={4}
                    disabled={peerBusy}
                  />
                </div>

                {peerError && (
                  <div className="wb-console__peers-error" role="alert">{peerError}</div>
                )}

                <div className="wb-console__peers-actions">
                  <button
                    className="wb-btn wb-btn--primary"
                    onClick={sendPeerMessage}
                    disabled={peerBusy || !peerText.trim() || !peerSessionId}
                  >
                    {peerBusy ? "Sending…" : "Send Peer Message"}
                  </button>
                </div>

                <div className="wb-console__peers-log">
                  <h4>Sent messages</h4>
                  {peerLog.length === 0 ? (
                    <p className="wb-console__empty">No messages sent yet.</p>
                  ) : (
                    <ul className="wb-console__peers-list">
                      {peerLog.slice().reverse().map((entry, idx) => (
                        <li key={idx} className={`wb-console__peer-entry ${entry.ok ? "ok" : "failed"}`}>
                          <div className="wb-console__peer-meta">
                            <span className="wb-console__peer-from">{entry.from}</span>
                            <span className="wb-console__peer-time">{new Date(entry.at).toLocaleTimeString()}</span>
                            <span className={`wb-console__peer-status ${entry.ok ? "ok" : "failed"}`}>
                              {entry.ok ? "sent" : "failed"}
                            </span>
                          </div>
                          <div className="wb-console__peer-text">{entry.text}</div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
