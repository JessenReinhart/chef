import { useEffect, useRef, useState } from "react";

interface BrowserSurfaceProps {
  initialUrl?: string;
  onNavigate: (url: string) => Promise<void> | void;
}

function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "about:blank";
  if (/^(about:|https?:\/\/)/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/** Mission-independent, inspectable browser surface for a selected Browser node. */
export function BrowserSurface({ initialUrl = "about:blank", onNavigate }: BrowserSurfaceProps) {
  const normalizedInitialUrl = normalizeUrl(initialUrl);
  const [draft, setDraft] = useState(initialUrl);
  const [url, setUrl] = useState(normalizedInitialUrl);
  const [history, setHistory] = useState<string[]>([normalizedInitialUrl]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const [navigating, setNavigating] = useState(false);
  const [frameLoading, setFrameLoading] = useState(normalizedInitialUrl !== "about:blank");
  const pendingUrlRef = useRef<string | null>(null);

  useEffect(() => {
    const next = normalizeUrl(initialUrl);

    // A successful local navigation is persisted through the parent and then
    // reflected back as initialUrl. Keep the in-surface history in that case.
    if (pendingUrlRef.current === next) {
      pendingUrlRef.current = null;
      setDraft(next);
      setUrl(next);
      return;
    }

    // A genuinely external/runtime restoration should become the new history
    // root rather than leaving stale browser-local entries around.
    if (next !== url) {
      setDraft(next);
      setUrl(next);
      setHistory([next]);
      setHistoryIndex(0);
      setNavigationError(null);
      setFrameLoading(next !== "about:blank");
    }
  }, [initialUrl]);

  const persistNavigation = async (next: string): Promise<boolean> => {
    setNavigationError(null);
    setNavigating(true);
    pendingUrlRef.current = next;
    try {
      // Persist runtime-owned browser state first. The iframe should only move
      // after the canvas patch succeeds so the visible surface never claims a
      // URL that Chef failed to save.
      await onNavigate(next);
      setDraft(next);
      setFrameLoading(next !== "about:blank");
      setUrl(next);
      return true;
    } catch (err) {
      pendingUrlRef.current = null;
      setDraft(url);
      setNavigationError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setNavigating(false);
    }
  };

  const navigate = async () => {
    const next = normalizeUrl(draft);
    if (!(await persistNavigation(next))) return;

    setHistory((current) => {
      const prefix = current.slice(0, historyIndex + 1);
      if (prefix[prefix.length - 1] === next) return prefix;
      const nextHistory = [...prefix, next];
      setHistoryIndex(nextHistory.length - 1);
      return nextHistory;
    });
  };

  const goToHistory = async (nextIndex: number) => {
    const next = history[nextIndex];
    if (!next || nextIndex === historyIndex) return;
    if (await persistNavigation(next)) setHistoryIndex(nextIndex);
  };

  const reload = () => {
    if (url === "about:blank" || navigating) return;
    setFrameLoading(true);
    setReloadNonce((value) => value + 1);
  };

  const pageState = navigating
    ? "Saving navigation…"
    : frameLoading
      ? "Loading page…"
      : url === "about:blank"
        ? "Browser ready"
        : "Page ready";

  return (
    <section className="browser-surface" aria-label="Browser surface">
      <form className="browser-surface__toolbar" onSubmit={(event) => { event.preventDefault(); void navigate(); }}>
        <span
          className="browser-surface__status"
          data-state={frameLoading ? "loading" : "ready"}
          aria-label={pageState}
          title={pageState}
        />
        <span className="whitespace-nowrap text-[10px] text-[#8b949e]" aria-live="polite">{pageState}</span>
        <button
          type="button"
          aria-label="Go back"
          title="Back"
          disabled={navigating || historyIndex === 0}
          onClick={() => void goToHistory(historyIndex - 1)}
        >
          ←
        </button>
        <button
          type="button"
          aria-label="Go forward"
          title="Forward"
          disabled={navigating || historyIndex >= history.length - 1}
          onClick={() => void goToHistory(historyIndex + 1)}
        >
          →
        </button>
        <button
          type="button"
          aria-label="Reload page"
          title="Reload"
          disabled={navigating || url === "about:blank"}
          onClick={reload}
        >
          ↻
        </button>
        <input
          aria-label="Browser address"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Enter a URL"
          disabled={navigating}
        />
        <button type="submit" disabled={navigating}>{navigating ? "Saving…" : "Go"}</button>
        {url !== "about:blank" && <a href={url} target="_blank" rel="noreferrer">Open externally</a>}
      </form>
      {navigationError && (
        <div className="browser-surface__error" role="status">
          Could not save navigation: {navigationError}
        </div>
      )}
      {url === "about:blank" ? (
        <div className="browser-surface__empty">Enter an address to use this Browser node.</div>
      ) : (
        <iframe
          key={`${url}:${reloadNonce}`}
          src={url}
          title={`Browser: ${url}`}
          sandbox="allow-forms allow-popups allow-same-origin allow-scripts"
          onLoad={() => setFrameLoading(false)}
        />
      )}
    </section>
  );
}
