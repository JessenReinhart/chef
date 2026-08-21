import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface TerminalViewProps {
  sessionId: string;
}

type ConnectionState = "connecting" | "live" | "reconnecting";

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: "Connecting event stream…",
  live: "Event stream connected",
  reconnecting: "Reconnecting event stream…",
};

export function TerminalView({ sessionId }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [inputError, setInputError] = useState<string | null>(null);

  // Initialize xterm terminal
  useEffect(() => {
    if (!containerRef.current) return;

    setConnectionState("connecting");
    setInputError(null);
    let disposed = false;

    const term = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
      fontSize: 13,
      lineHeight: 1.4,
      theme: {
        background: "#0d1117",
        foreground: "#e6edf3",
        cursor: "#d29922",
        cursorAccent: "#0d1117",
        selectionBackground: "#388bfd66",
        black: "#161b22",
        red: "#f85149",
        green: "#3fb950",
        yellow: "#d29922",
        blue: "#58a6ff",
        magenta: "#a371f7",
        cyan: "#39c5cf",
        white: "#e6edf3",
        brightBlack: "#6e7681",
        brightRed: "#ff7b72",
        brightGreen: "#56d364",
        brightYellow: "#e3b341",
        brightBlue: "#79c0ff",
        brightMagenta: "#d2a8ff",
        brightCyan: "#56d4dd",
        brightWhite: "#ffffff",
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    term.open(containerRef.current);

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    let lastCols = 0;
    let lastRows = 0;
    const syncPtySize = () => {
      if (!containerRef.current) return;
      fitAddon.fit();
      if (term.cols === lastCols && term.rows === lastRows) return;
      lastCols = term.cols;
      lastRows = term.rows;
      fetch("/api/sessions/resize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, cols: term.cols, rows: term.rows }),
      })
        .then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
        })
        .catch((err) => console.error("[TerminalView] resize failed:", err));
    };

    // Fit once after mount and keep the underlying PTY geometry in sync with
    // the visible xterm viewport. Without the runtime resize call, wrapping
    // and full-screen terminal apps continue using stale cols/rows.
    syncPtySize();

    // Handle terminal input — send to session via POST /api/sessions/send.
    // Input failures are visible in the terminal surface instead of only
    // disappearing into the browser console.
    term.onData((data) => {
      fetch("/api/sessions/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, data }),
      })
        .then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          if (!disposed) setInputError(null);
        })
        .catch((err) => {
          console.error("[TerminalView] send failed:", err);
          if (!disposed) setInputError("Input could not be delivered");
        });
    });

    // Handle resize
    const resizeObserver = new ResizeObserver(syncPtySize);
    resizeObserver.observe(containerRef.current);

    // Open EventSource for session.data events
    const es = new EventSource("/api/events?types=session.data");
    eventSourceRef.current = es;

    es.onopen = () => {
      if (!disposed) setConnectionState("live");
    };

    es.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data) as {
          type: string;
          sessionId?: string;
          payload?: { encoding?: string; data?: string };
        };
        if (event.type !== "session.data" || event.sessionId !== sessionId) return;
        const data = event.payload?.data;
        if (data === undefined) return;
        termRef.current?.write(data);
      } catch (err) {
        console.error("[TerminalView] parse event failed:", err);
      }
    };

    es.onerror = (err) => {
      console.error("[TerminalView] EventSource error:", err);
      if (!disposed) setConnectionState("reconnecting");
    };

    // Cleanup on unmount
    return () => {
      disposed = true;
      resizeObserver.disconnect();
      es.close();
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
      eventSourceRef.current = null;
    };
  }, [sessionId]);

  return (
    <div
      className="wb-terminal-view nodrag nopan nowheel"
      style={{ position: "relative", width: "100%", height: "100%", minHeight: 0 }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div ref={containerRef} style={{ width: "100%", height: "100%", minHeight: 0 }} />
      <div
        role="status"
        aria-live="polite"
        title={CONNECTION_LABEL[connectionState]}
        style={{
          position: "absolute",
          top: 8,
          right: 10,
          zIndex: 2,
          border: `1px solid ${connectionState === "live" ? "rgba(63, 185, 80, .35)" : "rgba(210, 153, 34, .35)"}`,
          borderRadius: 999,
          background: "rgba(13, 17, 23, .88)",
          padding: "2px 7px",
          color: connectionState === "live" ? "#56d364" : "#e3b341",
          fontSize: 10,
          lineHeight: 1.4,
          pointerEvents: "none",
        }}
      >
        {CONNECTION_LABEL[connectionState]}
      </div>
      {inputError && (
        <div
          role="alert"
          style={{
            position: "absolute",
            right: 10,
            bottom: 8,
            zIndex: 2,
            border: "1px solid rgba(248, 81, 73, .35)",
            borderRadius: 6,
            background: "rgba(13, 17, 23, .92)",
            padding: "4px 7px",
            color: "#ff7b72",
            fontSize: 10,
            pointerEvents: "none",
          }}
        >
          {inputError}
        </div>
      )}
    </div>
  );
}