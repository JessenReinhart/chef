import { useEffect, useRef, useState, useCallback } from "react";
import { api } from "./api";
import type { ChatMessage, LlmStatus, ViewMode } from "./types";
import { summarizeMissionProgress, type MissionProgressItem } from "./missionProgress";
import { subscribeMissionProgressProjection } from "./missionProgressStream";

interface ChatPanelProps {
  onPlanProposed: (taskIds: string[]) => void;
  mode: ViewMode;
}

interface SSEChatEvent {
  type: string;
  payload: {
    content?: string;
    taskIds?: string[];
    goal?: string;
    planId?: string;
    taskCount?: number;
    error?: string;
    ok?: boolean;
    status?: string;
  };
  seq?: number;
}

const QUICK_PROMPTS = [
  "Prepare this month's report and flag anything unusual",
  "Investigate and fix this bug",
  "Research the options and leave me a recommendation",
];

/** Assistant system message kind — colors the bubble without abusing `type`. */
type BubbleKind = "plan.proposed" | "plan.error" | "error";

interface BubbleMessage extends ChatMessage {
  bubbleKind?: BubbleKind;
}

export function ChatPanel({ onPlanProposed, mode }: ChatPanelProps) {
  const [messages, setMessages] = useState<BubbleMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [lastEventSeq, setLastEventSeq] = useState<number | undefined>(undefined);
  const [llmStatus, setLlmStatus] = useState<LlmStatus | null>(null);
  const [progress, setProgress] = useState<MissionProgressItem[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const onPlanProposedRef = useRef(onPlanProposed);
  onPlanProposedRef.current = onPlanProposed;
  const processedIdsRef = useRef<Set<string>>(new Set());

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Fetch LLM provider status on mount.
  useEffect(() => {
    let cancelled = false;
    api
      .llmStatus()
      .then((status) => {
        if (!cancelled) setLlmStatus(status);
      })
      .catch(() => {
        // LLM status endpoint optional — no-op if unavailable
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Build the human-readable Mission digest from durable Thread-scoped state on mount
  // and whenever the shared runtime stream signals that authoritative evidence changed.
  useEffect(() => subscribeMissionProgressProjection(
    async () => summarizeMissionProgress((await api.stateRaw()).events),
    setProgress,
  ), []);

  // Initial history load — dedupes messages already present.
  useEffect(() => {
    let cancelled = false;
    api
      .chatMessages()
      .then((msgs) => {
        if (cancelled) return;
        setMessages(
          msgs.filter((m) => m.content && m.timestamp > 0).map((m) => ({ ...m, bubbleKind: m.type === "error" ? "error" : undefined }))
        );
      })
      .catch(() => {
        // no history — fine
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // SSE subscription for live chat events (auto-reconnects; afterSeq param
  // makes restarts replay-safe).
  useEffect(() => {
    const es = new EventSource(`/api/chat/stream${lastEventSeq !== undefined ? `?afterSeq=${lastEventSeq + 1}` : ""}`);
    es.onmessage = (ev) => {
      try {
        const event = JSON.parse(ev.data) as SSEChatEvent;
        if (event.seq) setLastEventSeq(event.seq);
        const id = event.seq !== undefined ? String(event.seq) : `${event.type}:${event.payload.content ?? ""}`;

        switch (event.type) {
          case "chat.user": {
            // Echo user message from server (reconnect / catch-up).
            if (event.payload.content && !processedIdsRef.current.has(id)) {
              processedIdsRef.current.add(id);
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last?.role === "user" && last.content === event.payload.content) return prev;
                return [...prev, { role: "user", content: event.payload.content ?? "", timestamp: Date.now() }];
              });
            }
            break;
          }
          case "chat.assistant": {
            if (event.payload.content && !processedIdsRef.current.has(id)) {
              processedIdsRef.current.add(id);
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last?.role === "assistant" && last.content === event.payload.content) return prev;
                return [
                  ...prev,
                  {
                    role: "assistant",
                    content: event.payload.content ?? "",
                    timestamp: Date.now(),
                    bubbleKind: event.payload.ok === false ? "error" : undefined,
                  },
                ];
              });
            }
            setStreaming(false);
            break;
          }
          case "chat.plan.proposed": {
            if (event.payload.taskIds && !processedIdsRef.current.has(id)) {
              processedIdsRef.current.add(id);
              const taskIds = event.payload.taskIds;
              const count = event.payload.taskCount ?? taskIds.length;
              setMessages((prev) => [
                ...prev,
                {
                  role: "assistant",
                  content: mode === "simple"
                    ? `Mission started with ${count} planned step${count !== 1 ? "s" : ""}.`
                    : `Mission plan materialized ${count} runtime node${count !== 1 ? "s" : ""}.`,
                  timestamp: Date.now(),
                  bubbleKind: "plan.proposed",
                },
              ]);
              if (taskIds.length > 0) onPlanProposedRef.current(taskIds);
            }
            break;
          }
          case "chat.plan.error": {
            if (!processedIdsRef.current.has(id)) {
              processedIdsRef.current.add(id);
              setMessages((prev) => [
                ...prev,
                {
                  role: "assistant",
                  content: `Plan failed: ${event.payload.error ?? "unknown error"}`,
                  timestamp: Date.now(),
                  bubbleKind: "plan.error",
                },
              ]);
            }
            setStreaming(false);
            break;
          }
          case "chat.plan.none": {
            if (!processedIdsRef.current.has(id)) {
              processedIdsRef.current.add(id);
              setMessages((prev) => [
                ...prev,
                {
                  role: "assistant",
                  content: `No plan proposed for: ${event.payload.goal ?? "your request"}`,
                  timestamp: Date.now(),
                  bubbleKind: "plan.error",
                },
              ]);
            }
            setStreaming(false);
            break;
          }
          case "chat.plan.applied": {
            if (event.payload.status === "failed" && !processedIdsRef.current.has(id)) {
              processedIdsRef.current.add(id);
              setMessages((prev) => [
                ...prev,
                {
                  role: "assistant",
                  content: `Plan execution failed: ${event.payload.error ?? "unknown error"}`,
                  timestamp: Date.now(),
                  bubbleKind: "plan.error",
                },
              ]);
            }
            break;
          }
        }
      } catch {
        // ignore parse errors
      }
    };
    es.onerror = () => {
      // auto-reconnect handled by the browser
    };
    return () => es.close();
  }, [lastEventSeq, mode]);

  const send = useCallback(async () => {
    if (!input.trim() || streaming) return;
    const text = input.trim();
    setInput("");
    setStreaming(true);
    setMessages((prev) => [...prev, { role: "user", content: text, timestamp: Date.now() }]);

    try {
      const result = await api.chat(text);
      // The assistant reply arrives via SSE (chat.assistant). The POST
      // response is a fallback in case the stream missed it.
      if (!result.ok) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: result.report, timestamp: Date.now(), bubbleKind: "error" },
        ]);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Error: ${msg}`, timestamp: Date.now(), bubbleKind: "error" },
      ]);
    } finally {
      setStreaming(false);
      inputRef.current?.focus();
    }
  }, [input, streaming]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#0d1117]">
      {/* Header */}
      <div className="flex items-center justify-between h-12 px-4 border-b border-[#21262d] bg-[#010409]/80 backdrop-blur shrink-0">
        <div className="flex items-center gap-2">
          <span className="flex items-center justify-center h-6 w-6 rounded-md bg-cyan-500/15 border border-cyan-500/30">
            <svg className="h-3.5 w-3.5 text-cyan-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </span>
          <div className="leading-tight">
            <span className="text-sm font-semibold text-[#e6edf3]">Give Chef a goal</span>
            <span className="block text-[10px] text-[#8b949e]">{mode === "simple" ? "Mission desk" : "Orchestrator · mission control"}</span>
          </div>
        </div>
        {streaming && (
          <span className="flex items-center gap-1.5 text-xs text-cyan-400">
            <span className="h-2 w-2 rounded-full bg-cyan-400 animate-pulse" />
            <span>Chef is thinking…</span>
          </span>
        )}
      </div>

      {progress.length > 0 && (
        <div className="mx-3 mt-3 shrink-0 rounded-lg border border-[#30363d] bg-[#010409]/60 p-2.5" aria-label="Mission progress">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8b949e]">Mission progress</span>
            <span className="text-[10px] text-[#6e7681]">latest {progress.length}</span>
          </div>
          <div className="space-y-1.5">
            {progress.map((item) => (
              <div key={item.id} className="flex items-start gap-2 text-[11px] leading-4">
                <span
                  className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
                    item.tone === "success" ? "bg-green-400"
                    : item.tone === "attention" ? "bg-amber-400"
                    : item.tone === "active" ? "bg-cyan-400"
                    : "bg-[#6e7681]"
                  }`}
                />
                <span className="min-w-0 flex-1 text-[#c9d1d9]">{item.text}</span>
                {mode === "power" && (
                  <code className="max-w-28 shrink-0 truncate text-[9px] text-[#6e7681]" title={item.eventType}>{item.eventType}</code>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-3 space-y-4" ref={messagesEndRef}>
        {messages.length === 0 && (
          <div className="text-center text-[#8b949e] pt-10 px-2 space-y-4">
            <div className="mx-auto h-11 w-11 rounded-xl bg-[#161b22] border border-[#30363d] flex items-center justify-center">
              <svg className="h-5 w-5 text-cyan-400/70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <div>
              <p className="text-sm text-[#e6edf3]">What should the workspace accomplish?</p>
              <p className="text-xs mt-1">Chef coordinates the people and tools already here, then keeps you updated.</p>
            </div>
            <div className="flex flex-col items-center gap-2">
              {QUICK_PROMPTS.map((p, i) => (
                <button
                  key={i}
                  onClick={() => {
                    setInput(p);
                    inputRef.current?.focus();
                  }}
                  className="w-full max-w-xs px-3 py-2 text-left text-xs rounded-lg border border-[#30363d] bg-[#161b22] text-[#8b949e] hover:text-[#e6edf3] hover:border-cyan-500/50 hover:bg-cyan-500/5 transition-colors"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((msg, idx) => (
          <div key={idx} className={`flex gap-3 ${msg.role === "user" ? "flex-row-reverse" : ""}`}>
            <div
              className={`flex-shrink-0 h-7 w-7 rounded-full flex items-center justify-center text-xs font-semibold ${
                msg.role === "user"
                  ? "bg-cyan-500/20 text-cyan-400 border border-cyan-500/30"
                  : "bg-green-500/20 text-green-400 border border-green-500/30"
              }`}
            >
              {msg.role === "user" ? "U" : "C"}
            </div>
            <div className={`max-w-[80%] ${msg.role === "user" ? "text-right" : "text-left"}`}>
              <div
                className={`inline-block px-3 py-2 rounded-2xl text-sm leading-relaxed ${
                  msg.role === "user"
                    ? "bg-cyan-500/10 border border-cyan-500/20 text-[#e6edf3] rounded-br-md"
                    : msg.bubbleKind === "plan.proposed"
                    ? "bg-amber-500/10 border border-amber-500/20 text-[#e6edf3] rounded-bl-md"
                    : msg.bubbleKind === "plan.error" || msg.bubbleKind === "error"
                    ? "bg-red-500/10 border border-red-500/20 text-red-300 rounded-bl-md"
                    : "bg-green-500/10 border border-green-500/20 text-[#e6edf3] rounded-bl-md"
                }`}
              >
                {msg.content}
              </div>
              <div className="mt-1 text-[10px] text-[#8b949e]">
                {new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* LLM provider status — informational only */}
      {mode === "power" && llmStatus !== null && !llmStatus.configured && (
        <div className="mx-3 mt-2 px-3 py-2 rounded-lg border border-amber-500/30 bg-amber-500/10 text-xs text-amber-300 shrink-0">
          <span className="font-semibold">LLM not configured</span> — using scripted planner. Set{" "}
          <code className="px-1 py-0.5 rounded bg-[#161b22] text-amber-200">CHEF_PROVIDER</code>,{" "}
          <code className="px-1 py-0.5 rounded bg-[#161b22] text-amber-200">CHEF_API_KEY</code>,{" "}
          <code className="px-1 py-0.5 rounded bg-[#161b22] text-amber-200">CHEF_MODEL</code> to enable.
        </div>
      )}
      {mode === "power" && llmStatus !== null && llmStatus.configured && (
        <div className="mx-3 mt-2 px-3 py-1.5 rounded-lg border border-green-500/25 bg-green-500/5 text-[11px] text-green-300 shrink-0 flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
          <span>
            LLM: <span className="font-mono">{llmStatus.provider}</span>
            {llmStatus.model ? <span className="font-mono">/{llmStatus.model}</span> : null}
          </span>
        </div>
      )}

      {/* Input */}
      <div className="p-3 border-t border-[#21262d] bg-[#010409]/80 backdrop-blur shrink-0">
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Describe the outcome you want…"
            disabled={streaming}
            className="flex-1 bg-[#161b22] border border-[#30363d] rounded-lg px-3 py-2 text-sm text-[#e6edf3] placeholder-[#8b949e] focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500 disabled:opacity-50 transition-colors"
            autoFocus
          />
          <button
            onClick={send}
            disabled={!input.trim() || streaming}
            className="px-4 py-2 bg-cyan-500 text-[#010409] font-medium rounded-lg hover:bg-cyan-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}