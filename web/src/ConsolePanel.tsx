import { useState } from "react";
import type { RuntimeEvent } from "../../src/core/types.ts";
import { NodeIcon } from "./nodeCatalog.tsx";

interface ConsolePanelProps {
  events: RuntimeEvent[];
}

export function ConsolePanel({ events }: ConsolePanelProps) {
  const [activeTab, setActiveTab] = useState<"events" | "chat">("events");
  const [chatInput, setChatInput] = useState("");
  const [messages, setMessages] = useState<
    Array<{ role: "user" | "assistant"; content: string; timestamp: number }>
  >([]);

  const sendChat = async () => {
    if (!chatInput.trim()) return;
    const userMsg = { role: "user" as const, content: chatInput, timestamp: Date.now() };
    setMessages((prev) => [...prev, userMsg]);
    setChatInput("");

    // Placeholder: In the future this would send to /api/chat or similar
    // For now we echo with a helpful response
    setTimeout(() => {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant" as const,
          content: `I received: "${chatInput}". The Chef chat integration is coming soon — for now you can use the event stream to observe runtime activity.`,
          timestamp: Date.now(),
        },
      ]);
    }, 300);
  };

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
          <button
            className={`wb-console__tab ${activeTab === "events" ? "wb-console__tab--active" : ""}`}
            role="tab"
            aria-selected={activeTab === "events"}
            onClick={() => setActiveTab("events")}
          >
            Events
          </button>
          <button
            className={`wb-console__tab ${activeTab === "chat" ? "wb-console__tab--active" : ""}`}
            role="tab"
            aria-selected={activeTab === "chat"}
            onClick={() => setActiveTab("chat")}
          >
            Chat with Chef
          </button>
        </div>
      </header>

      <div className="wb-console__content">
        {/* Events panel */}
        <div className={`wb-console__panel ${activeTab === "events" ? "wb-console__panel--active" : ""}`} role="tabpanel">
          {events.length === 0 ? (
            <p style={{ color: "var(--fg-muted)", fontSize: 13, margin: "8px 0" }}>No events yet.</p>
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
                <div style={{ color: "var(--fg-muted)", fontSize: 13, textAlign: "center", padding: "24px 0" }}>
                  <NodeIcon category="Agents" size={32} style={{ marginBottom: 8, opacity: 0.3 }} />
                  <p>Chat with Chef is coming soon.</p>
                  <p style={{ fontSize: 12 }}>You'll be able to explain, build, and troubleshoot workflows here.</p>
                </div>
              )}
              {messages.map((msg, idx) => (
                <div key={idx} className={`wb-console__message ${msg.role === "user" ? "wb-console__message--user" : "wb-console__message--assistant"}`}>
                  <div className="wb-console__message-avatar">{msg.role === "user" ? "U" : "C"}</div>
                  <div className="wb-console__message-content">{msg.content}</div>
                </div>
              ))}
            </div>
            <form className="wb-console__input-form" onSubmit={(e) => { e.preventDefault(); sendChat(); }}>
              <input
                className="wb-console__input"
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="Message Chef…"
                aria-label="Chat input"
              />
              <button type="submit" className="wb-btn wb-btn--primary" disabled={!chatInput.trim()}>
                Send
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}