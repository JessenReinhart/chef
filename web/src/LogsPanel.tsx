import { useEffect, useState, useCallback, useRef } from "react";
import type { RuntimeEvent } from "../../src/core/types.ts";

interface LogsPanelProps {
  selectedNodeId: string | null;
  selectedSessionId: string | null;
}

const EVENT_TYPE_COLORS: Record<string, string> = {
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
  "node.started": "var(--accent-green)",
  "node.completed": "var(--accent-blue)",
  "node.failed": "var(--accent-red)",
  "node.cancelled": "var(--fg-muted)",
};

const MAX_EVENTS = 500;

export function LogsPanel({ selectedNodeId, selectedSessionId }: LogsPanelProps) {
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [filterTypes, setFilterTypes] = useState<string>("*");
  const [filterText, setFilterText] = useState("");
  const [paused, setPaused] = useState(false);
  const [expandedEvent, setExpandedEvent] = useState<string | null>(null);
  const [lastSeq, setLastSeq] = useState<number | null>(null);
  const [eventSource, setEventSource] = useState<EventSource | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScroll = useRef(true);

  const fetchInitialEvents = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (lastSeq !== null) params.set("afterSeq", String(lastSeq));
      if (filterTypes && filterTypes !== "*") params.set("types", filterTypes);
      const res = await fetch(`/api/inspector/events?${params.toString()}`);
      const data = await res.json();
      if (data.ok && data.data?.length > 0) {
        const newEvents = data.data as RuntimeEvent[];
        setEvents((prev) => [...prev, ...newEvents].slice(-MAX_EVENTS));
        const maxSeq = Math.max(...newEvents.map((e) => e.seq));
        setLastSeq(maxSeq);
      }
    } catch (err) {
      console.error("Failed to fetch initial events:", err);
    }
  }, [lastSeq, filterTypes]);

  useEffect(() => {
    fetchInitialEvents();
    const es = new EventSource(`/api/events${filterTypes && filterTypes !== "*" ? `?types=${encodeURIComponent(filterTypes)}` : ""}`);
    es.onmessage = (msg) => {
      if (paused) return;
      const event = JSON.parse(msg.data) as RuntimeEvent;
      setEvents((prev) => {
        const next = [...prev, event].slice(-MAX_EVENTS);
        return next;
      });
      setLastSeq(event.seq);
    };
    setEventSource(es);
    return () => {
      es.close();
    };
  }, [filterTypes, paused, fetchInitialEvents]);

  useEffect(() => {
    if (shouldAutoScroll.current && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [events]);

  const handleScroll = () => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    shouldAutoScroll.current = scrollHeight - scrollTop - clientHeight < 50;
  };

  const filteredEvents = events.filter((event) => {
    if (selectedNodeId && event.taskId !== selectedNodeId) return false;
    if (selectedSessionId && event.sessionId !== selectedSessionId) return false;
    if (filterText) {
      const text = filterText.toLowerCase();
      const haystack = `${event.type} ${JSON.stringify(event.payload)} ${event.source?.id ?? ""}`.toLowerCase();
      if (!haystack.includes(text)) return false;
    }
    return true;
  });

  const formatTimestamp = (ts: number) => {
    const date = new Date(ts);
    return `${date.toLocaleTimeString()}.${String(date.getMilliseconds()).padStart(3, "0")}`;
  };

  const getTypeColor = (type: string) => EVENT_TYPE_COLORS[type] || "var(--fg-secondary)";

  const formatPayload = (payload: unknown) => {
    if (payload === null || payload === undefined) return "";
    if (typeof payload === "string") return payload;
    try {
      return JSON.stringify(payload, null, 2);
    } catch {
      return String(payload);
    }
  };

  return (
    <div className="wb-logs" role="region" aria-label="Live logs">
      <div className="wb-logs__header">
        <h3 className="wb-logs__title">Live Logs</h3>
        <div className="wb-logs__controls">
          <select
            className="wb-logs__filter"
            value={filterTypes}
            onChange={(e) => setFilterTypes(e.target.value)}
            aria-label="Filter by event type"
          >
            <option value="*">All events</option>
            <option value="task.*,session.*,plan.*,approval.*,artifact.*,node.*">Tasks & Sessions</option>
            <option value="task.*">Tasks only</option>
            <option value="session.*">Sessions only</option>
            <option value="session.data">Session PTY data</option>
            <option value="plan.*">Plans only</option>
            <option value="approval.*">Approvals only</option>
            <option value="artifact.*">Artifacts only</option>
            <option value="node.*">Node events only</option>
          </select>
          <input
            className="wb-logs__search"
            type="text"
            placeholder="Search events…"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            aria-label="Search events"
          />
          <button
            className={`wb-btn wb-btn--ghost ${paused ? "wb-btn--active" : ""}`}
            onClick={() => setPaused((p) => !p)}
            aria-pressed={paused}
            title={paused ? "Resume live stream" : "Pause live stream"}
          >
            {paused ? "▶ Resume" : "⏸ Pause"}
          </button>
          <button className="wb-btn wb-btn--ghost" onClick={() => setEvents([])} title="Clear logs">
            Clear
          </button>
        </div>
      </div>
      <div
        className="wb-logs__content"
        ref={containerRef}
        onScroll={handleScroll}
        tabIndex={0}
      >
        {filteredEvents.length === 0 && (
          <div className="wb-logs__empty">
            {paused ? "Stream paused" : "No events matching filters"}
          </div>
        )}
        {filteredEvents.map((event) => (
          <div
            key={event.id}
            className="wb-logs__event"
            style={{ borderLeftColor: getTypeColor(event.type) }}
            onClick={() => setExpandedEvent((prev) => (prev === event.id ? null : event.id))}
          >
            <span className="wb-logs__event-seq">#{event.seq}</span>
            <span className="wb-logs__event-time">{formatTimestamp(event.timestamp)}</span>
            <span className="wb-logs__event-type" style={{ color: getTypeColor(event.type) }}>
              {event.type}
            </span>
            <span className="wb-logs__event-source">
              {event.source?.type}:{event.source?.id?.slice(0, 12)}
            </span>
            <span className="wb-logs__event-preview">
              {(() => {
                const payload = event.payload as Record<string, unknown> | string | null;
                if (typeof payload === "string") return payload.slice(0, 120);
                if (payload?.data) return String(payload.data).slice(0, 120);
                if (payload?.encoding && payload?.data) return `[${payload.encoding}] ${String(payload.data).slice(0, 100)}`;
                return "";
              })()}
            </span>
            {expandedEvent === event.id && (
              <div className="wb-logs__event-expanded">
                <pre>{formatPayload(event.payload)}</pre>
                <div className="wb-logs__event-meta">
                  <div>ID: {event.id}</div>
                  <div>Task: {event.taskId ?? "—"}</div>
                  <div>Session: {event.sessionId ?? "—"}</div>
                  <div>Correlation: {event.correlationId ?? "—"}</div>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="wb-logs__footer">
        <span>{filteredEvents.length} / {events.length} events</span>
        <span className={paused ? "wb-logs__paused" : "wb-logs__live"}>
          {paused ? "Paused" : "Live"}
        </span>
      </div>
    </div>
  );
}