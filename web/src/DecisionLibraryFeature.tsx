import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { Decision, DecisionStatus } from "../../src/core/types.ts";

const STATUS_OPTIONS: Array<{ value: "all" | DecisionStatus; label: string }> = [
  { value: "all", label: "All" },
  { value: "proposed", label: "Proposed" },
  { value: "accepted", label: "Accepted" },
  { value: "rejected", label: "Rejected" },
];

async function loadDecisions(status: "all" | DecisionStatus): Promise<Decision[]> {
  const query = status === "all" ? "" : `?status=${encodeURIComponent(status)}`;
  const response = await fetch(`/api/decisions${query}`);
  const body = await response.json() as { ok?: boolean; data?: Decision[]; error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body.data ?? [];
}

function statusClass(status: DecisionStatus): string {
  if (status === "accepted") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-300";
  if (status === "rejected") return "border-red-500/30 bg-red-500/10 text-red-300";
  return "border-amber-500/30 bg-amber-500/10 text-amber-300";
}

function DecisionLibrary({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<"all" | DecisionStatus>("all");
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await loadDecisions(status);
      setDecisions(next);
      setSelectedId((current) => current && next.some((decision) => decision.id === current) ? current : next[0]?.id ?? null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, [status]);

  const selected = useMemo(
    () => decisions.find((decision) => decision.id === selectedId) ?? null,
    [decisions, selectedId],
  );

  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-black/60 p-4" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <section className="flex h-[min(720px,88vh)] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-[#30363d] bg-[#0d1117] shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-[#21262d] p-4">
          <div>
            <h2 className="text-sm font-semibold text-[#e6edf3]">Decision Library</h2>
            <p className="mt-1 text-xs text-[#8b949e]">Durable orchestrator and reviewer decisions for this workspace. Runtime state remains authoritative.</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => void refresh()} disabled={loading} className="header-quiet-button disabled:opacity-50">Refresh</button>
            <button onClick={onClose} className="text-lg text-[#8b949e] hover:text-white" aria-label="Close Decision Library">×</button>
          </div>
        </header>

        <div className="flex items-center gap-2 border-b border-[#21262d] px-4 py-3 text-xs">
          <span className="text-[#8b949e]">Status</span>
          {STATUS_OPTIONS.map((option) => (
            <button
              key={option.value}
              onClick={() => setStatus(option.value)}
              className={status === option.value
                ? "rounded border border-cyan-500/40 bg-cyan-500/10 px-2.5 py-1 text-cyan-300"
                : "rounded border border-[#30363d] px-2.5 py-1 text-[#8b949e] hover:text-[#e6edf3]"}
            >
              {option.label}
            </button>
          ))}
          <span className="ml-auto text-[#6e7681]">{decisions.length} decision{decisions.length === 1 ? "" : "s"}</span>
        </div>

        {error ? (
          <div className="m-4 rounded border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">{error}</div>
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-[minmax(260px,0.8fr)_minmax(0,1.4fr)]">
            <div className="overflow-y-auto border-r border-[#21262d]">
              {loading && decisions.length === 0 ? (
                <p className="p-4 text-xs text-[#8b949e]">Loading decisions…</p>
              ) : decisions.length === 0 ? (
                <div className="p-4">
                  <p className="text-sm text-[#e6edf3]">No decisions in this view</p>
                  <p className="mt-1 text-xs text-[#8b949e]">Decisions appear here when the orchestrator or runtime records a durable choice.</p>
                </div>
              ) : decisions.map((decision) => (
                <button
                  key={decision.id}
                  onClick={() => setSelectedId(decision.id)}
                  className={`block w-full border-b border-[#21262d] p-3 text-left hover:bg-[#161b22] ${selectedId === decision.id ? "bg-[#161b22]" : ""}`}
                >
                  <div className="flex items-center gap-2">
                    <span className={`rounded border px-1.5 py-0.5 text-[10px] uppercase ${statusClass(decision.status)}`}>{decision.status}</span>
                    <code className="truncate text-[10px] text-[#6e7681]">{decision.type}</code>
                  </div>
                  <p className="mt-2 text-xs font-medium text-[#e6edf3]">{decision.summary}</p>
                  <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-[#6e7681]">
                    <span className="truncate">by {decision.madeBy}</span>
                    <time>{new Date(decision.timestamp).toLocaleString()}</time>
                  </div>
                </button>
              ))}
            </div>

            <div className="min-w-0 overflow-y-auto p-4">
              {selected ? (
                <div className="space-y-5 text-xs">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded border px-2 py-1 text-[10px] uppercase ${statusClass(selected.status)}`}>{selected.status}</span>
                      <code className="text-[#8b949e]">{selected.type}</code>
                    </div>
                    <h3 className="mt-3 text-base font-semibold text-[#e6edf3]">{selected.summary}</h3>
                  </div>

                  <dl className="grid grid-cols-[100px_minmax(0,1fr)] gap-x-3 gap-y-2 rounded-lg border border-[#21262d] bg-[#010409] p-3">
                    <dt className="text-[#6e7681]">Made by</dt><dd className="text-[#c9d1d9]">{selected.madeBy}</dd>
                    <dt className="text-[#6e7681]">Recorded</dt><dd className="text-[#c9d1d9]">{new Date(selected.timestamp).toLocaleString()}</dd>
                    <dt className="text-[#6e7681]">Decision ID</dt><dd className="break-all font-mono text-[#8b949e]">{selected.id}</dd>
                  </dl>

                  <div>
                    <h4 className="mb-2 font-medium text-[#c9d1d9]">Payload</h4>
                    <pre className="max-h-[360px] overflow-auto rounded-lg border border-[#21262d] bg-[#010409] p-3 font-mono text-[11px] leading-5 text-[#8b949e]">{JSON.stringify(selected.payload, null, 2) ?? "null"}</pre>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-[#8b949e]">Select a decision to inspect its durable payload.</p>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

export function DecisionLibraryFeature() {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const resolve = () => {
      const header = document.querySelector("#root > div > header");
      if (!(header instanceof HTMLElement)) return;
      const children = Array.from(header.children).filter((child): child is HTMLElement => child instanceof HTMLElement);
      setHost(children[1] ?? null);
    };
    resolve();
    const observer = new MutationObserver(resolve);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return <>
    {host && createPortal(<button onClick={() => setOpen(true)} className="header-quiet-button">Decisions</button>, host)}
    {open && <DecisionLibrary onClose={() => setOpen(false)} />}
  </>;
}
