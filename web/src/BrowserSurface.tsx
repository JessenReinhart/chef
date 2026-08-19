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

  useEffect(() => {
    setDraft(initialUrl);
    setUrl(normalizeUrl(initialUrl));
  }, [initialUrl]);

  const navigate = async () => {
    const next = normalizeUrl(draft);
    setDraft(next);
    setUrl(next);
    await onNavigate(next);
  };

  return (
    <section className="browser-surface" aria-label="Browser surface">
      <form className="browser-surface__toolbar" onSubmit={(event) => { event.preventDefault(); void navigate(); }}>
        <span className="browser-surface__status" aria-label="Browser connected" />
        <input aria-label="Browser address" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Enter a URL" />
        <button type="submit">Go</button>
        {url !== "about:blank" && <a href={url} target="_blank" rel="noreferrer">Open externally</a>}
      </form>
      {url === "about:blank" ? (
        <div className="browser-surface__empty">Enter an address to use this Browser node.</div>
      ) : (
        <iframe key={url} src={url} title={`Browser: ${url}`} sandbox="allow-forms allow-popups allow-same-origin allow-scripts" />
      )}
    </section>
  );
}
