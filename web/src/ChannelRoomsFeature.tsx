import { useCallback, useEffect, useMemo, useState } from "react";
import "./channel-rooms.css";

type ChannelSummary = {
  channel: string;
  messageCount: number;
};

type ChannelMessage = {
  id: string;
  from: string;
  to?: string;
  channel?: string;
  type: string;
  payload: unknown;
  replyTo?: string;
  timestamp: number;
};

const MAX_PREVIEW = 1_200;

function truncate(text: string): string {
  return text.length > MAX_PREVIEW ? `${text.slice(0, MAX_PREVIEW)}…` : text;
}

function roomLabel(channel: string): string {
  return channel.startsWith("#") ? channel : `# ${channel}`;
}

function messageText(payload: unknown): string {
  if (typeof payload === "string") return truncate(payload);
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    for (const key of ["text", "message", "content", "summary"]) {
      if (typeof record[key] === "string" && record[key].trim()) return truncate(record[key] as string);
    }
  }
  try {
    const text = JSON.stringify(payload);
    return text === undefined ? "No message body" : truncate(text);
  } catch {
    return "Message payload could not be displayed";
  }
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(timestamp);
}

export function ChannelRoomsFeature() {
  const [enabled, setEnabled] = useState(() => localStorage.getItem("chef:view-mode") === "power");
  const [open, setOpen] = useState(false);
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChannelMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = localStorage.getItem("chef:view-mode") === "power";
      setEnabled(next);
      if (!next) setOpen(false);
    }, 250);
    return () => window.clearInterval(timer);
  }, []);

  const loadChannels = useCallback(async () => {
    const response = await fetch("/api/messages/channels");
    if (!response.ok) throw new Error(`Could not load rooms (HTTP ${response.status})`);
    const body = (await response.json()) as { ok: boolean; data?: ChannelSummary[]; error?: string };
    if (!body.ok) throw new Error(body.error ?? "Could not load rooms");
    const next = body.data ?? [];
    setChannels(next);
    setSelectedChannel((current) => {
      if (current && next.some((item) => item.channel === current)) return current;
      return next[0]?.channel ?? null;
    });
  }, []);

  const loadMessages = useCallback(async (channel: string) => {
    const response = await fetch(`/api/messages?channel=${encodeURIComponent(channel)}`);
    if (!response.ok) throw new Error(`Could not load ${roomLabel(channel)} (HTTP ${response.status})`);
    const body = (await response.json()) as { ok: boolean; data?: ChannelMessage[]; error?: string };
    if (!body.ok) throw new Error(body.error ?? `Could not load ${roomLabel(channel)}`);
    setMessages(body.data ?? []);
  }, []);

  const sendMessage = useCallback(async () => {
    const text = draft.trim();
    if (!selectedChannel || !text || sending) return;
    setSending(true);
    try {
      const response = await fetch("/api/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: selectedChannel, text }),
      });
      const body = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !body.ok) throw new Error(body.error ?? `Could not send to ${roomLabel(selectedChannel)}`);
      setDraft("");
      await Promise.all([loadMessages(selectedChannel), loadChannels()]);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `Could not send to ${roomLabel(selectedChannel)}`);
    } finally {
      setSending(false);
    }
  }, [draft, selectedChannel, sending, loadMessages, loadChannels]);

  useEffect(() => {
    if (!enabled || !open) return;
    let cancelled = false;
    const refresh = async () => {
      setLoading(true);
      try {
        await loadChannels();
        if (!cancelled) setError(null);
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not load rooms");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled, open, loadChannels]);

  useEffect(() => {
    if (!enabled || !open || !selectedChannel) {
      if (!selectedChannel) setMessages([]);
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        await loadMessages(selectedChannel);
        if (!cancelled) setError(null);
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : `Could not load ${roomLabel(selectedChannel)}`);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled, open, selectedChannel, loadMessages]);

  const orderedMessages = useMemo(
    () => [...messages].sort((a, b) => a.timestamp - b.timestamp),
    [messages],
  );

  if (!enabled) return null;

  return (
    <section className={`chef-rooms ${open ? "is-open" : ""}`} aria-label="Agent rooms">
      <button
        type="button"
        className="chef-rooms__launcher"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls="chef-rooms-panel"
      >
        <span aria-hidden="true">#</span>
        Rooms
        {channels.length > 0 && <i>{channels.length}</i>}
      </button>

      {open && (
        <div id="chef-rooms-panel" className="chef-rooms__panel">
          <header className="chef-rooms__header">
            <div>
              <span>Collaboration</span>
              <strong>Agent rooms</strong>
            </div>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close rooms">×</button>
          </header>

          {error && <div className="chef-rooms__error" role="alert">{error}</div>}

          <div className="chef-rooms__body">
            <nav className="chef-rooms__channels" aria-label="Rooms">
              {channels.map((item) => (
                <button
                  key={item.channel}
                  type="button"
                  className={selectedChannel === item.channel ? "is-active" : ""}
                  onClick={() => setSelectedChannel(item.channel)}
                >
                  <span>{roomLabel(item.channel)}</span>
                  <i>{item.messageCount}</i>
                </button>
              ))}
              {!loading && channels.length === 0 && (
                <p>No shared rooms yet. They appear when durable messages use a channel.</p>
              )}
              {loading && channels.length === 0 && <p>Looking for rooms…</p>}
            </nav>

            <div className="chef-rooms__conversation" aria-live="polite">
              {selectedChannel ? (
                <>
                  <div className="chef-rooms__conversation-title">
                    <strong>{roomLabel(selectedChannel)}</strong>
                    <span>{orderedMessages.length} message{orderedMessages.length === 1 ? "" : "s"}</span>
                  </div>
                  <div className="chef-rooms__messages">
                    {orderedMessages.map((message) => (
                      <article key={message.id} className="chef-room-message">
                        <div className="chef-room-message__meta">
                          <strong>{message.from}</strong>
                          {message.to && <span>→ {message.to}</span>}
                          <time>{formatTime(message.timestamp)}</time>
                        </div>
                        <p>{messageText(message.payload)}</p>
                        <span className="chef-room-message__type">{message.type.replaceAll("_", " ")}</span>
                      </article>
                    ))}
                    {orderedMessages.length === 0 && (
                      <div className="chef-rooms__empty-message">This room has no messages yet.</div>
                    )}
                  </div>
                  <div className="chef-rooms__composer">
                    <textarea
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") void sendMessage();
                      }}
                      placeholder={`Message ${roomLabel(selectedChannel)} as human…`}
                      maxLength={10_000}
                      rows={2}
                    />
                    <button type="button" onClick={() => void sendMessage()} disabled={!draft.trim() || sending}>
                      {sending ? "Sending…" : "Send"}
                    </button>
                  </div>
                </>
              ) : (
                <div className="chef-rooms__blank">
                  <span>#</span>
                  <strong>Shared rooms will show up here</strong>
                  <p>Rooms are a lightweight view over Chef's durable agent messages. They do not create a second source of truth.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
