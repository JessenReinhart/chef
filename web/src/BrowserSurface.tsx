import { useEffect, useState } from "react";

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
  const [draft, setDraft] = useState(initialUrl);
  const [url, setUrl] = useState(normalizeUrl(initialUrl));
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const [navigating, setNavigating] = useState(false);

  useEffect(() => {
    setDraft(initialUrl);
    setUrl(normalizeUrl(initialUrl));
    setNavigationError(null);
  }, [initialUrl]);

  const navigate = async () => {
    const next = normalizeUrl(draft);
    setNavigationError(null);
    setNavigating(true);
    try {
      // Persist runtime-owned browser state first. The iframe should only move
      // after the canvas patch succeeds so the visible surface never claims a
      // URL that Chef failed to save.
      await onNavigate(next);
      setDraft(next);
      setUrl(next);
    } catch (err) {
      setDraft(url);
      setNavigationError(err instanceof Error ? err.message : String(err));
    } finally {
      setNavigating(false);
    }
  };

  return (
    <section className="browser-surface" aria-label="Browser surface">
      <form className="browser-surface__toolbar" onSubmit={(event) => { event.preventDefault(); void navigate(); }}>
        <span className="browser-surface__status" aria-label="Browser connected" />
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
        <iframe key={url} src={url} title={`Browser: ${url}`} sandbox="allow-forms allow-popups allow-same-origin allow-scripts" />
      )}
    </section>
  );
}
