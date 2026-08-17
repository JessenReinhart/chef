import { useEffect, useState, useCallback } from "react";
import { api } from "./api";
import { TerminalView } from "./TerminalView";

type Session = {
  id: string;
  taskId: string;
  status: string;
  pid: number;
};

const POLL_INTERVAL_MS = 2000;
const LIVE_STATUSES: Record<string, boolean> = { spawning: true, running: true };

export function TerminalPanel() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const refreshSessions = useCallback(async () => {
    try {
      const list = await api.sessions();
      setSessions(list);
      setFetchError(null);
    } catch (err) {
      setFetchError((err as Error)?.message ?? "Failed to load sessions");
    }
  }, []);

  useEffect(() => {
    void refreshSessions();
    const handle = setInterval(() => {
      void refreshSessions();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(handle);
  }, [refreshSessions]);

  const selected = sessions.find((s) => s.id === selectedSessionId);

  return (
    <div className="wb-terminal-panel" role="region" aria-label="Terminal">
      <div className="wb-terminal-panel__sidebar">
        <h4 className="wb-terminal-panel__title">Sessions</h4>
        {fetchError && (
          <div className="wb-terminal-panel__error" role="status">
            {fetchError}
          </div>
        )}
        {sessions.length === 0 ? (
          <p className="wb-terminal-panel__empty">
            {fetchError ? "Retrying…" : "No active sessions."}
          </p>
        ) : (
          <ul className="wb-terminal-panel__list">
            {sessions.map((s) => {
              const live = LIVE_STATUSES[s.status] === true;
              const active = selectedSessionId === s.id;
              return (
                <li key={s.id}>
                  <button
                    className={`wb-terminal-panel__item ${active ? "wb-terminal-panel__item--active" : ""} ${
                      live ? "wb-terminal-panel__item--live" : ""
                    }`}
                    role="tab"
                    aria-selected={active}
                    onClick={() => setSelectedSessionId(s.id)}
                  >
                    <span
                      className="wb-terminal-panel__status-dot"
                      data-status={s.status}
                      aria-label={s.status}
                      title={s.status}
                    />
                    <span className="wb-terminal-panel__task" title={s.taskId}>
                      {s.taskId.slice(0, 8)}
                    </span>
                    <span className="wb-terminal-panel__pid">pid {s.pid}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="wb-terminal-panel__view flex-1">
        {selectedSessionId && selected ? (
          <TerminalView sessionId={selectedSessionId} />
        ) : sessions.length > 0 ? (
          <div className="wb-terminal-panel__placeholder">
            Select a session to view its terminal.
          </div>
        ) : (
          <div className="wb-terminal-panel__placeholder">
            Awaiting sessions…
          </div>
        )}
      </div>
    </div>
  );
}
