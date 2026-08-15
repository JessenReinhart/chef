import { useEffect, useRef, useState } from "react";
import type { RuntimeEvent } from "../../src/core/types.ts";
import { NodeIcon } from "./nodeCatalog.tsx";

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

export function ConsolePanel({ events }: { events: RuntimeEvent[] }) {
  const [activeTab, setActiveTab] = useState<"events" | "chat">("events");
  const [chatInput, setChatInput] = useState("");
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSeq, setLastSeq] = useState(0);
  const messagesRef = useRef<ChatMessageView[]>([]);
  const streamRef = useRef<EventSource | null>(null);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Track the max event seq for replay.
  useEffect(() => {
    setLastSeq((prev) => Math.max(prev, ...events.map((e) => e.seq)));
  }, [events]);

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

        // Streaming progress (plan proposed / applied): accumulate into the
        // current assistant bubble if one is open, otherwise start one.
        if (!pendingAssistant) {
          pendingAssistant = { role: "assistant", content, timestamp: event.timestamp };
          setStreaming(true);
          setMessages((prev) => [...prev, pendingAssistant as ChatMessageView]);
        } else {
          pendingAssistant = { ...pendingAssistant, content: pendingAssistant.content + "\n" + content };
          setMessages((prev) => prev.map((m) => (m === pendingAssistant ? pendingAssistant! : m)));
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
                  <p>Chat with Chef</p>
                  <p style={{ fontSize: 12 }}>Describe a workflow and Chef will plan, validate, and run it.</p>
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
      </div>
    </div>
  );
}
