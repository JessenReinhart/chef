import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

const STYLES = `
.agent-quick-message{position:fixed;right:14px;bottom:56px;z-index:44;font-size:12px}.agent-quick-message__toggle{border:1px solid #30363d;border-radius:999px;background:rgba(13,17,23,.96);padding:8px 12px;color:#c9d1d9;box-shadow:0 10px 35px rgba(0,0,0,.35)}.agent-quick-message__toggle:hover{border-color:#3fb950;color:#f0f6fc}.agent-quick-message__panel{position:absolute;right:0;bottom:42px;width:min(390px,calc(100vw - 28px));display:flex;flex-direction:column;overflow:hidden;border:1px solid #30363d;border-radius:12px;background:rgba(13,17,23,.98);color:#c9d1d9;box-shadow:0 22px 70px rgba(0,0,0,.55);backdrop-filter:blur(16px)}.agent-quick-message__panel>header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:12px 14px;border-bottom:1px solid #21262d}.agent-quick-message__panel>header strong{display:block;color:#f0f6fc;font-size:13px}.agent-quick-message__panel>header span{display:block;margin-top:2px;color:#6e7681;font-size:10px}.agent-quick-message__panel>header button{border:0;background:transparent;color:#8b949e;font-size:18px}.agent-quick-message__body{display:grid;gap:10px;padding:12px}.agent-quick-message__body label span{display:block;margin-bottom:4px;color:#6e7681;font-size:9px;text-transform:uppercase;letter-spacing:.06em}.agent-quick-message__body select,.agent-quick-message__body textarea{box-sizing:border-box;width:100%;border:1px solid #30363d;border-radius:7px;background:#010409;padding:8px;color:#c9d1d9;font:inherit}.agent-quick-message__body textarea{min-height:90px;resize:vertical;line-height:1.45}.agent-quick-message__agent-meta{display:flex;align-items:center;gap:7px;color:#8b949e;font-size:10px}.agent-quick-message__status{display:inline-flex;align-items:center;gap:4px;border-radius:999px;background:#161b22;padding:3px 7px;color:#8b949e}.agent-quick-message__status::before{content:"";width:6px;height:6px;border-radius:50%;background:#6e7681}.agent-quick-message__status[data-live="true"]::before{background:#3fb950}.agent-quick-message__send{border:1px solid #238636;border-radius:7px;background:#238636;padding:8px 10px;color:#fff;font-weight:600}.agent-quick-message__send:hover:not(:disabled){background:#2ea043}.agent-quick-message__send:disabled{cursor:not-allowed;opacity:.5}.agent-quick-message__feedback{min-height:16px;color:#8b949e;font-size:10px}.agent-quick-message__feedback.is-error{color:#ff7b72}.agent-quick-message__feedback.is-success{color:#56d364}.agent-quick-message__empty{padding:22px 14px;color:#6e7681;text-align:center}@media(max-width:640px){.agent-quick-message{right:8px;bottom:52px}}
`;

type Task = {
  id: string;
  title: string;
  status: string;
};

type CanvasNode = {
  id: string;
  taskId?: string;
  label?: string;
  kind?: string;
  harnessId?: string | null;
};

type AgentOption = {
  nodeId: string;
  taskId?: string;
  label: string;
  status: string;
  harnessId?: string | null;
};

type StateSnapshot = {
  tasks?: Task[];
  canvasNodes?: CanvasNode[];
};

function isLiveStatus(status: string): boolean {
  return status === "running" || status === "assigned" || status === "spawning" || status === "pending";
}

function projectAgents(snapshot: StateSnapshot): AgentOption[] {
  const tasks = new Map((snapshot.tasks ?? []).map((task) => [task.id, task]));
  return (snapshot.canvasNodes ?? [])
    .filter((node) => node.kind === "agent")
    .map((node) => {
      const task = node.taskId ? tasks.get(node.taskId) : tasks.get(node.id);
      return {
        nodeId: node.id,
        taskId: task?.id ?? node.taskId,
        label: node.label ?? task?.title ?? node.harnessId ?? "Agent",
        status: task?.status ?? "idle",
        harnessId: node.harnessId,
      };
    })
    .sort((a, b) => Number(isLiveStatus(b.status)) - Number(isLiveStatus(a.status)) || a.label.localeCompare(b.label));
}

function AgentQuickMessagePanel() {
  const [open, setOpen] = useState(false);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "error" | "success"; text: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const response = await fetch("/api/state");
        const body = await response.json() as StateSnapshot & { error?: string };
        if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
        if (cancelled) return;
        const nextAgents = projectAgents(body);
        setAgents(nextAgents);
        setSelectedNodeId((current) => nextAgents.some((agent) => agent.nodeId === current) ? current : nextAgents[0]?.nodeId ?? "");
      } catch (caught) {
        if (!cancelled) setFeedback({ kind: "error", text: caught instanceof Error ? caught.message : "Failed to load agents" });
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [open]);

  const selected = useMemo(() => agents.find((agent) => agent.nodeId === selectedNodeId), [agents, selectedNodeId]);

  const send = async () => {
    const text = message.trim();
    if (!selected || !text || loading) return;
    setLoading(true);
    setFeedback(null);
    try {
      const response = await fetch(`/api/nodes/${encodeURIComponent(selected.nodeId)}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      setMessage("");
      setFeedback({ kind: "success", text: `Sent to ${selected.label}.` });
    } catch (caught) {
      setFeedback({ kind: "error", text: caught instanceof Error ? caught.message : "Failed to send message" });
    } finally {
      setLoading(false);
    }
  };

  return <div className="agent-quick-message">
    <button type="button" className="agent-quick-message__toggle" aria-expanded={open} onClick={() => setOpen((current) => !current)}>Talk to agent</button>
    {open && <section className="agent-quick-message__panel" aria-label="Talk directly to an agent">
      <header><div><strong>Talk to an agent</strong><span>Send a direct instruction without creating a new Mission.</span></div><button type="button" onClick={() => setOpen(false)} aria-label="Close agent message panel">×</button></header>
      {agents.length === 0 ? <div className="agent-quick-message__empty">No agent is present on the canvas yet.</div> : <div className="agent-quick-message__body">
        <label><span>Agent</span><select value={selectedNodeId} onChange={(event) => { setSelectedNodeId(event.target.value); setFeedback(null); }}>{agents.map((agent) => <option key={agent.nodeId} value={agent.nodeId}>{agent.label}</option>)}</select></label>
        {selected && <div className="agent-quick-message__agent-meta"><span className="agent-quick-message__status" data-live={isLiveStatus(selected.status)}>{selected.status}</span>{selected.harnessId && <span>{selected.harnessId}</span>}</div>}
        <label><span>Instruction</span><textarea value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") void send(); }} placeholder="Ask, redirect, or give this agent more context…" /></label>
        <button type="button" className="agent-quick-message__send" disabled={!selected || !message.trim() || loading} onClick={() => void send()}>{loading ? "Sending…" : "Send instruction"}</button>
        <div className={`agent-quick-message__feedback${feedback ? ` is-${feedback.kind}` : ""}`}>{feedback?.text ?? "Ctrl/Cmd + Enter to send."}</div>
      </div>}
    </section>}
  </div>;
}

const style = document.createElement("style");
style.textContent = STYLES;
document.head.appendChild(style);
const host = document.createElement("div");
host.id = "chef-agent-quick-message-root";
document.body.appendChild(host);
createRoot(host).render(<AgentQuickMessagePanel />);
