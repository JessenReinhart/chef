import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface TerminalViewProps {
  sessionId: string;
}

export function TerminalView({ sessionId }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);


  // Initialize xterm terminal
  useEffect(() => {
    if (!containerRef.current) return;

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
    fitAddon.fit();

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    // Handle terminal input — send to session via POST /api/sessions/send
    term.onData((data) => {
      fetch("/api/sessions/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, data }),
      }).catch((err) => console.error("[TerminalView] send failed:", err));
    });

    // Handle resize
    const handleResize = () => {
      if (termRef.current && fitAddonRef.current && containerRef.current) {
        fitAddonRef.current.fit();
      }
    };
    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(containerRef.current);

    // Open EventSource for session.data events
    const es = new EventSource("/api/events?types=session.data");
    eventSourceRef.current = es;

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
    };

    // Cleanup on unmount
    return () => {
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
      ref={containerRef}
      className="wb-terminal-view"
      style={{ width: "100%", height: "100%", minHeight: 0 }}
    />
  );
}