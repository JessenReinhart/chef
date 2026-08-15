import { useEffect, useRef, useState, useCallback } from "react";
import type { Session } from "../../src/core/types.ts";

interface TerminalPanesProps {
  sessions: Session[];
  selectedSessionId: string | null;
  onSessionSelect: (sessionId: string | null) => void;
}

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;

interface TerminalState {
  sessionId: string;
  cols: number;
  rows: number;
  buffer: string;
  history: string[];
  historyIndex: number;
  inputBuffer: string;
}

const RUNNING_STATUSES = new Set(["spawning", "running"]);

export function TerminalPanes({ sessions, selectedSessionId, onSessionSelect }: TerminalPanesProps) {
  const [terminals, setTerminals] = useState<Map<string, TerminalState>>(new Map());
  const [eventSources, setEventSources] = useState<Map<string, EventSource>>(new Map());
  const outputRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const inputRefs = useRef<Map<string, HTMLInputElement>>(new Map());

  const runningSessions = sessions.filter((s) => RUNNING_STATUSES.has(s.status));
  const runningIds = runningSessions.map((s) => s.id).join(",");

  // Create a terminal state entry (with a fresh PTY EventSource) for every
  // running session. Keyed by the joined id string so the map is stable
  // across re-renders that don't change the running set.
  useEffect(() => {
    const newTerminals = new Map(terminals);
    const newEventSources = new Map(eventSources);
    let changed = false;

    runningSessions.forEach((session) => {
      if (!newTerminals.has(session.id)) {
        changed = true;
        newTerminals.set(session.id, {
          sessionId: session.id,
          cols: session.cols || DEFAULT_COLS,
          rows: session.rows || DEFAULT_ROWS,
          buffer: "",
          history: [],
          historyIndex: 0,
          inputBuffer: "",
        });
      }
      if (!newEventSources.has(session.id)) {
        changed = true;
        const es = new EventSource("/api/events?types=session.data");
        es.onmessage = (msg) => {
          const event = JSON.parse(msg.data) as {
            type: string;
            sessionId?: string;
            payload?: { encoding?: string; data?: string };
          };
          if (event.type !== "session.data" || event.sessionId !== session.id) return;
          const data = event.payload?.data;
          if (data === undefined) return;
          setTerminals((prev) => {
            const term = prev.get(session.id);
            if (!term) return prev;
            const next = new Map(prev);
            next.set(session.id, { ...term, buffer: term.buffer + data });
            return next;
          });
        };
        newEventSources.set(session.id, es);
      }
    });

    if (changed) {
      setTerminals(newTerminals);
      setEventSources(newEventSources);
    }

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningIds]);

  // Clean up event sources for sessions that stopped running.
  useEffect(() => {
    eventSources.forEach((es, sessionId) => {
      if (!runningIds.split(",").includes(sessionId)) {
        es.close();
        const next = new Map(eventSources);
        next.delete(sessionId);
        setEventSources(next);
      }
    });
  }, [runningIds, eventSources]);

  // Auto-select the first running session when nothing is selected.
  useEffect(() => {
    if (!selectedSessionId && runningSessions.length > 0) {
      onSessionSelect(runningSessions[0].id);
    }
  }, [selectedSessionId, runningIds, onSessionSelect, runningSessions]);

  // Close every EventSource on unmount.
  useEffect(() => {
    const sources = eventSources;
    return () => {
      sources.forEach((es) => es.close());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendInput = useCallback(async (sessionId: string, data: string) => {
    await fetch("/api/sessions/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, data }),
    });
  }, []);

  const resizeTerminal = useCallback(async (sessionId: string, cols: number, rows: number) => {
    await fetch("/api/sessions/resize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, cols, rows }),
    });
    setTerminals((prev) => {
      const term = prev.get(sessionId);
      if (!term) return prev;
      const next = new Map(prev);
      next.set(sessionId, { ...term, cols, rows });
      return next;
    });
  }, []);

  const interruptSession = useCallback(async (sessionId: string) => {
    await fetch("/api/sessions/interrupt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
  }, []);

  const handleKeyDown = (sessionId: string, e: React.KeyboardEvent<HTMLInputElement>) => {
    const term = terminals.get(sessionId);
    if (!term) return;

    if (e.key === "Enter") {
      e.preventDefault();
      const input = term.inputBuffer + "\n";
      void sendInput(sessionId, input);
      setTerminals((prev) => {
        const current = prev.get(sessionId);
        if (!current) return prev;
        const next = new Map(prev);
        next.set(sessionId, {
          ...current,
          history: [...current.history, current.inputBuffer],
          historyIndex: current.history.length + 1,
          inputBuffer: "",
        });
        return next;
      });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const current = terminals.get(sessionId);
      if (!current || current.historyIndex <= 0) return;
      const newIndex = current.historyIndex - 1;
      setTerminals((prev) => {
        const t = prev.get(sessionId);
        if (!t) return prev;
        const next = new Map(prev);
        next.set(sessionId, { ...t, historyIndex: newIndex, inputBuffer: t.history[newIndex] });
        return next;
      });
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const current = terminals.get(sessionId);
      if (!current || current.historyIndex >= current.history.length) return;
      const newIndex = current.historyIndex + 1;
      const value = newIndex === current.history.length ? "" : current.history[newIndex];
      setTerminals((prev) => {
        const t = prev.get(sessionId);
        if (!t) return prev;
        const next = new Map(prev);
        next.set(sessionId, { ...t, historyIndex: newIndex, inputBuffer: value });
        return next;
      });
    } else if (e.key === "Tab") {
      e.preventDefault();
      void sendInput(sessionId, "\t");
    }
  };

  const handleInputChange = (sessionId: string, value: string) => {
    setTerminals((prev) => {
      const term = prev.get(sessionId);
      if (!term) return prev;
      const next = new Map(prev);
      next.set(sessionId, { ...term, inputBuffer: value });
      return next;
    });
  };

  const handleSessionFocus = (sessionId: string) => {
    if (selectedSessionId !== sessionId) {
      onSessionSelect(sessionId);
    }
    // Give the PTY accurate dimensions on focus.
    const output = outputRefs.current.get(sessionId);
    if (output) {
      const rect = output.getBoundingClientRect();
      const fontSize = 12;
      const cols = Math.max(20, Math.floor(rect.width / (fontSize * 0.6)));
      const rows = Math.max(5, Math.floor(rect.height / (fontSize * 1.5)));
      const term = terminals.get(sessionId);
      if (term && (term.cols !== cols || term.rows !== rows)) {
        void resizeTerminal(sessionId, cols, rows);
      }
    }
  };

  const renderTerminal = (session: Session) => {
    const term = terminals.get(session.id);
    const isActive = selectedSessionId === session.id;
    if (!term) return null;

    const output = outputRefs.current.get(session.id);
    if (output) {
      output.scrollTop = output.scrollHeight;
    }

    return (
      <div
        key={session.id}
        className={`wb-terminal ${isActive ? "wb-terminal--active" : ""}`}
        role="tabpanel"
        aria-label={`Terminal: ${session.command} (pid ${session.pid})`}
        hidden={!isActive}
      >
        <div className="wb-terminal__header">
          <div className="wb-terminal__title">
            <span className="wb-terminal__prompt">chef@workspace</span>
            <span className="wb-terminal__separator">:</span>
            <span className="wb-terminal__path">~</span>
            <span className="wb-terminal__dollar">$</span>
          </div>
          <div className="wb-terminal__badges">
            <span className={`wb-status-dot wb-status-dot--${session.status}`} />
            <span className="wb-terminal__pid">pid {session.pid}</span>
            <span className="wb-terminal__size">{term.cols}×{term.rows}</span>
            <button
              className="wb-btn wb-btn--ghost wb-btn--sm"
              onClick={() => void interruptSession(session.id)}
              title="Send interrupt (Ctrl+C)"
            >
              ⏹
            </button>
          </div>
        </div>
        <div
          className="wb-terminal__output"
          ref={(el) => {
            if (el) outputRefs.current.set(session.id, el);
          }}
          onClick={() => handleSessionFocus(session.id)}
        >
          <pre>{term.buffer.length > 0 ? term.buffer : "chef@workspace:~$ "}</pre>
        </div>
        <div className="wb-terminal__input-line">
          <span className="wb-terminal__input-prompt">chef@workspace:~$ </span>
          <input
            ref={(el) => {
              if (el) inputRefs.current.set(session.id, el);
            }}
            className="wb-terminal__input"
            type="text"
            value={term.inputBuffer}
            onChange={(e) => handleInputChange(session.id, e.target.value)}
            onKeyDown={(e) => handleKeyDown(session.id, e)}
            onFocus={() => handleSessionFocus(session.id)}
            autoComplete="off"
            spellCheck={false}
            aria-label="Terminal input"
          />
        </div>
      </div>
    );
  };

  return (
    <div className="wb-terminal-panes" role="region" aria-label="Terminal panes">
      <div className="wb-terminal-panes__tabs" role="tablist">
        {runningSessions.map((session) => (
          <button
            key={session.id}
            role="tab"
            aria-selected={selectedSessionId === session.id}
            className={`wb-terminal-panes__tab ${selectedSessionId === session.id ? "wb-terminal-panes__tab--active" : ""}`}
            onClick={() => handleSessionFocus(session.id)}
          >
            <span className={`wb-status-dot wb-status-dot--${session.status}`} />
            {session.command || session.id.slice(0, 8)} · pid {session.pid}
          </button>
        ))}
        {runningSessions.length === 0 && (
          <span className="wb-terminal-panes__empty">No running sessions</span>
        )}
      </div>
      <div className="wb-terminal-panes__content">
        {runningSessions.map(renderTerminal)}
      </div>
    </div>
  );
}