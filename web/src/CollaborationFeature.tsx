import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

const STYLES = `
.collaboration-feature{position:fixed;right:14px;bottom:14px;z-index:45;font-size:12px}.collaboration-feature__toggle{border:1px solid #30363d;border-radius:999px;background:rgba(13,17,23,.96);padding:8px 12px;color:#c9d1d9;box-shadow:0 10px 35px rgba(0,0,0,.35)}.collaboration-feature__toggle:hover{border-color:#58a6ff;color:#f0f6fc}.collaboration-feature__panel{position:absolute;right:0;bottom:42px;width:min(430px,calc(100vw - 28px));max-height:min(620px,calc(100vh - 90px));display:flex;flex-direction:column;overflow:hidden;border:1px solid #30363d;border-radius:12px;background:rgba(13,17,23,.98);color:#c9d1d9;box-shadow:0 22px 70px rgba(0,0,0,.55);backdrop-filter:blur(16px)}.collaboration-feature__panel>header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:12px 14px;border-bottom:1px solid #21262d}.collaboration-feature__panel>header strong{display:block;color:#f0f6fc;font-size:13px}.collaboration-feature__panel>header span{display:block;margin-top:2px;color:#6e7681;font-size:10px}.collaboration-feature__panel>header button{border:0;background:transparent;color:#8b949e;font-size:18px}.collaboration-feature__filters{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:10px 12px;border-bottom:1px solid #21262d}.collaboration-feature__filters label span{display:block;margin-bottom:4px;color:#6e7681;font-size:9px;text-transform:uppercase;letter-spacing:.06em}.collaboration-feature__filters select{width:100%;min-width:0;border:1px solid #30363d;border-radius:6px;background:#010409;padding:6px 8px;color:#c9d1d9}.collaboration-feature__list{margin:0;padding:8px;overflow-y:auto;list-style:none}.collaboration-feature__list li{padding:9px 10px;border-bottom:1px solid #21262d}.collaboration-feature__list li:last-child{border-bottom:0}.collaboration-feature__message-head{display:flex;align-items:center;gap:5px;min-width:0;color:#8b949e;font-size:10px}.collaboration-feature__message-head strong{color:#e6edf3}.collaboration-feature__message-head code{min-width:0;overflow:hidden;color:#67e8f9;text-overflow:ellipsis;white-space:nowrap}.collaboration-feature__message-head time{margin-left:auto;color:#484f58}.collaboration-feature__list p{margin:5px 0 3px;overflow-wrap:anywhere;color:#c9d1d9;line-height:1.45;white-space:pre-wrap}.collaboration-feature__list small{color:#6e7681;text-transform:capitalize}.collaboration-feature__empty{padding:28px 16px;color:#6e7681;text-align:center}.collaboration-feature__empty.is-error{color:#ff7b72}@media(max-width:640px){.collaboration-feature{right:8px;bottom:8px}.collaboration-feature__filters{grid-template-columns:1fr}}
`;

type Message = { id: string; from: string; to?: string; channel?: string; type: string; payload: unknown; timestamp: number };

function messageText(message: Message): string {
  if (typeof message.payload === "string") return message.payload;
  if (message.payload && typeof message.payload === "object") {
    const payload = message.payload as Record<string, unknown>;
    const candidate = payload.text ?? payload.content ?? payload.report ?? payload.summary;
    if (typeof candidate === "string") return candidate;
  }
  return JSON.stringify(message.payload);
}

function CollaborationPanel() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [channel, setChannel] = useState("all");
  const [agent, setAgent] = useState("all");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const response = await fetch("/api/messages");
        const body = await response.json() as { ok?: boolean; data?: Message[]; error?: string };
        if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
        if (!cancelled) { setMessages(body.data ?? []); setError(null); }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Failed to load messages");
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [open]);

  const channels = useMemo(() => [...new Set(messages.map((message) => message.channel ?? "direct"))].sort(), [messages]);
  const agents = useMemo(() => [...new Set(messages.flatMap((message) => [message.from, message.to].filter(Boolean) as string[]))].sort(), [messages]);
  const visible = useMemo(() => messages.filter((message) => {
    const messageChannel = message.channel ?? "direct";
    return (channel === "all" || messageChannel === channel) && (agent === "all" || message.from === agent || message.to === agent);
  }).slice().reverse(), [messages, channel, agent]);

  return <div className="collaboration-feature">
    <button type="button" className="collaboration-feature__toggle" aria-expanded={open} onClick={() => setOpen((current) => !current)}>Messages{messages.length ? ` · ${messages.length}` : ""}</button>
    {open && <section className="collaboration-feature__panel" aria-label="Agent collaboration messages">
      <header><div><strong>Collaboration</strong><span>Durable agent messages and channels</span></div><button type="button" onClick={() => setOpen(false)} aria-label="Close collaboration panel">×</button></header>
      <div className="collaboration-feature__filters">
        <label><span>Channel</span><select value={channel} onChange={(event) => setChannel(event.target.value)}><option value="all">All channels</option>{channels.map((value) => <option key={value} value={value}>#{value}</option>)}</select></label>
        <label><span>Agent</span><select value={agent} onChange={(event) => setAgent(event.target.value)}><option value="all">Everyone</option>{agents.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
      </div>
      {error ? <div className="collaboration-feature__empty is-error">{error}</div> : visible.length === 0 ? <div className="collaboration-feature__empty">No matching messages yet.</div> : <ol className="collaboration-feature__list">{visible.map((message) => <li key={message.id}><div className="collaboration-feature__message-head"><strong>{message.from}</strong><span>→ {message.to ?? "channel"}</span><code>#{message.channel ?? "direct"}</code><time>{new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div><p>{messageText(message)}</p><small>{message.type}</small></li>)}</ol>}
    </section>}
  </div>;
}

const style = document.createElement("style");
style.textContent = STYLES;
document.head.appendChild(style);
const host = document.createElement("div");
host.id = "chef-collaboration-root";
document.body.appendChild(host);
createRoot(host).render(<CollaborationPanel />);
