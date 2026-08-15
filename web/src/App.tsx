import { useEffect, useState } from "react";
import type { RuntimeEvent, WorkspaceSnapshot } from "../../src/core/types.ts";

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

function statusColor(status: string): string {
  switch (status) {
    case "running":
      return "green";
    case "spawning":
      return "gold";
    case "completed":
      return "steelblue";
    case "failed":
    case "crashed":
      return "crimson";
    case "terminated":
      return "gray";
    default:
      return "darkgray";
  }
}

export function App() {
  const [state, setState] = useState<DashboardState>({ snapshot: null, events: [], sessions: [] });
  const [input, setInput] = useState("");

  const refresh = async () => {
    const res = await fetch("/api/state");
    const snapshot = (await res.json()) as WorkspaceSnapshot;
    const sessions: SessionInfo[] = snapshot.sessions.map((s) => ({
      id: s.id,
      taskId: s.taskId,
      status: s.status,
      pid: s.pid,
    }));
    setState((prev) => ({ ...prev, snapshot, sessions }));
  };

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
  }, []);

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

  const snapshot = state.snapshot;
  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: 16, background: "#0d1117", color: "#e6edf3", minHeight: "100vh" }}>
      <h1 style={{ fontSize: 20, margin: "0 0 12px" }}>Chef Inspector</h1>
      <p style={{ color: "#8b949e", fontSize: 13, margin: "0 0 16px" }}>
        Read-only projection. The runtime remains authoritative (spec §4).
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <section style={{ border: "1px solid #30363d", borderRadius: 8, padding: 12 }}>
          <h2 style={{ fontSize: 14, margin: "0 0 8px" }}>Tasks</h2>
          {snapshot?.tasks.map((task) => (
            <div key={task.id} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6, fontSize: 13 }}>
              <span style={{ color: statusColor(task.status), fontWeight: 700 }}>{task.status}</span>
              <span>{task.title}</span>
              <span style={{ color: "#8b949e" }}>{task.assignedTo ?? "unassigned"}</span>
            </div>
          ))}
        </section>

        <section style={{ border: "1px solid #30363d", borderRadius: 8, padding: 12 }}>
          <h2 style={{ fontSize: 14, margin: "0 0 8px" }}>Sessions</h2>
          {state.sessions.map((session) => (
            <div key={session.id} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6, fontSize: 13 }}>
              <span style={{ color: statusColor(session.status), fontWeight: 700 }}>{session.status}</span>
              <span style={{ color: "#8b949e" }}>pid {session.pid}</span>
              <span>{session.id.slice(0, 8)}</span>
            </div>
          ))}
          <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void send()}
              placeholder="input to running session"
              style={{ flex: 1, background: "#161b22", color: "#e6edf3", border: "1px solid #30363d", borderRadius: 6, padding: "6px 8px" }}
            />
            <button onClick={() => void send()} style={{ background: "#238636", color: "#fff", border: "none", borderRadius: 6, padding: "6px 10px", cursor: "pointer" }}>
              Send
            </button>
            <button onClick={() => void interrupt()} style={{ background: "#da3633", color: "#fff", border: "none", borderRadius: 6, padding: "6px 10px", cursor: "pointer" }}>
              Interrupt
            </button>
          </div>
        </section>
      </div>

      <section style={{ border: "1px solid #30363d", borderRadius: 8, padding: 12, marginTop: 16 }}>
        <h2 style={{ fontSize: 14, margin: "0 0 8px" }}>Event Stream ({state.events.length})</h2>
        <div style={{ maxHeight: 320, overflowY: "auto", fontFamily: "monospace", fontSize: 12 }}>
          {state.events.map((event) => (
            <div key={event.id} style={{ marginBottom: 2, color: "#8b949e" }}>
              <span style={{ color: "#79c0ff" }}>#{event.seq}</span> {event.type}
              <span style={{ color: "#8b949e" }}> — {JSON.stringify(event.payload)}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
