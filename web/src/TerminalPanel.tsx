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
  const [taskTitles, setTaskTitles] = useState<Record<string, string>>({});
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const refreshSessions = useCallback(async () => {
    try {
      const [list, state] = await Promise.all([api.sessions(), api.stateRaw()]);
      setSessions(list);
      setTaskTitles(Object.fromEntries(state.tasks.map((task) => [task.id, task.title])));
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

  useEffect(() => {
    if (sessions.length === 0) {
      if (selectedSessionId !== null) setSelectedSessionId(null);
      return;
    }
    if (selectedSessionId && sessions.some((session) => session.id === selectedSessionId)) return;
    const preferred = sessions.find((session) => LIVE_STATUSES[session.status] === true) ?? sessions[0];
    setSelectedSessionId(preferred.id);
  }, [sessions, selectedSessionId]);

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
              const taskTitle = taskTitles[s.taskId] ?? s.taskId.slice(0, 8);
              return (
                <li key={s.id}>
                  <button
                    className={`wb-terminal-panel__item ${active ? "wb-terminal-panel__item--active" : ""} ${
                      live ? "wb-terminal-panel__item--live" : ""
                    }`}
                    role="tab"
                    aria-selected={active}
                    onClick={() => setSelectedSessionId(s.id)}
                    title={`${taskTitle} · ${s.status} · pid ${s.pid}`}
                  >
                    <span
                      className="wb-terminal-panel__status-dot"
                      data-status={s.status}
                      aria-label={s.status}
                      title={s.status}
                    />
                    <span className="wb-terminal-panel__task" title={taskTitle}>
                      {taskTitle}
                    </span>
                    <span className="wb-terminal-panel__pid">{s.status}</span>
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
