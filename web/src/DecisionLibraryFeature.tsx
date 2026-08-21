import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { Decision, DecisionStatus } from "../../src/core/types.ts";

type LibraryView = "decisions" | "memory";
type MemoryCategory = "decisions" | "requirements" | "knownFacts" | "conventions" | "lessons" | "openQuestions" | "reusableProcedures";
type MemoryProjection = {
  categories: Record<MemoryCategory, Decision[]>;
  counts: Record<MemoryCategory, number>;
};

const STATUS_OPTIONS: Array<{ value: "all" | DecisionStatus; label: string }> = [
  { value: "all", label: "All" },
  { value: "proposed", label: "Proposed" },
  { value: "accepted", label: "Accepted" },
  { value: "rejected", label: "Rejected" },
];

const MEMORY_CATEGORIES: Array<{ key: MemoryCategory; label: string; description: string }> = [
  { key: "decisions", label: "Decisions", description: "Accepted and rejected durable choices." },
  { key: "requirements", label: "Requirements", description: "Accepted constraints and requested behavior." },
  { key: "knownFacts", label: "Known Facts", description: "Accepted facts the workspace can rely on." },
  { key: "conventions", label: "Conventions", description: "Accepted project and team conventions." },
  { key: "lessons", label: "Lessons", description: "Accepted lessons preserved from prior work." },
  { key: "openQuestions", label: "Open Questions", description: "Unresolved questions that still need an answer." },
  { key: "reusableProcedures", label: "Reusable Procedures", description: "Accepted procedures worth repeating." },
];

async function loadDecisions(status: "all" | DecisionStatus): Promise<Decision[]> {
  const query = status === "all" ? "" : `?status=${encodeURIComponent(status)}`;
  const response = await fetch(`/api/decisions${query}`);
  const body = await response.json() as { ok?: boolean; data?: Decision[]; error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body.data ?? [];
}

async function loadMemory(): Promise<MemoryProjection> {
  const response = await fetch("/api/memory");
  const body = await response.json() as { ok?: boolean; data?: MemoryProjection; error?: string };
  if (!response.ok || !body.data) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body.data;
}

function statusClass(status: DecisionStatus): string {
  if (status === "accepted") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-300";
  if (status === "rejected") return "border-red-500/30 bg-red-500/10 text-red-300";
  return "border-amber-500/30 bg-amber-500/10 text-amber-300";
}

function DecisionDetail({ decision }: { decision: Decision | null }) {
  if (!decision) return <p className="text-xs text-[#8b949e]">Select an item to inspect its durable provenance.</p>;
  return (
    <div className="space-y-5 text-xs">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded border px-2 py-1 text-[10px] uppercase ${statusClass(decision.status)}`}>{decision.status}</span>
          <code className="text-[#8b949e]">{decision.type}</code>
        </div>
        <h3 className="mt-3 text-base font-semibold text-[#e6edf3]">{decision.summary}</h3>
      </div>
      <dl className="grid grid-cols-[100px_minmax(0,1fr)] gap-x-3 gap-y-2 rounded-lg border border-[#21262d] bg-[#010409] p-3">
        <dt className="text-[#6e7681]">Made by</dt><dd className="text-[#c9d1d9]">{decision.madeBy}</dd>
        <dt className="text-[#6e7681]">Recorded</dt><dd className="text-[#c9d1d9]">{new Date(decision.timestamp).toLocaleString()}</dd>
        <dt className="text-[#6e7681]">Record ID</dt><dd className="break-all font-mono text-[#8b949e]">{decision.id}</dd>
      </dl>
      <div>
        <h4 className="mb-2 font-medium text-[#c9d1d9]">Payload</h4>
        <pre className="max-h-[360px] overflow-auto rounded-lg border border-[#21262d] bg-[#010409] p-3 font-mono text-[11px] leading-5 text-[#8b949e]">{JSON.stringify(decision.payload, null, 2) ?? "null"}</pre>
      </div>
    </div>
  );
}

function KnowledgeLibrary({ onClose }: { onClose: () => void }) {
  const [view, setView] = useState<LibraryView>("decisions");
  const [status, setStatus] = useState<"all" | DecisionStatus>("all");
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [memory, setMemory] = useState<MemoryProjection | null>(null);
  const [memoryCategory, setMemoryCategory] = useState<MemoryCategory>("decisions");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      if (view === "decisions") {
        const next = await loadDecisions(status);
        setDecisions(next);
        setSelectedId((current) => current && next.some((decision) => decision.id === current) ? current : next[0]?.id ?? null);
      } else {
        const next = await loadMemory();
        setMemory(next);
        const items = next.categories[memoryCategory];
        setSelectedId((current) => current && items.some((item) => item.id === current) ? current : items[0]?.id ?? null);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, [view, status, memoryCategory]);

  const memoryItems = memory?.categories[memoryCategory] ?? [];
  const currentItems = view === "decisions" ? decisions : memoryItems;
  const selected = useMemo(
    () => currentItems.find((decision) => decision.id === selectedId) ?? null,
    [currentItems, selectedId],
  );
  const selectedCategory = MEMORY_CATEGORIES.find((category) => category.key === memoryCategory) ?? MEMORY_CATEGORIES[0];

  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-black/60 p-4" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <section className="flex h-[min(760px,90vh)] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-[#30363d] bg-[#0d1117] shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-[#21262d] p-4">
          <div>
            <h2 className="text-sm font-semibold text-[#e6edf3]">Knowledge Library</h2>
            <p className="mt-1 text-xs text-[#8b949e]">Inspectable durable knowledge for this workspace. Runtime records remain authoritative.</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => void refresh()} disabled={loading} className="header-quiet-button disabled:opacity-50">Refresh</button>
            <button onClick={onClose} className="text-lg text-[#8b949e] hover:text-white" aria-label="Close Knowledge Library">×</button>
          </div>
        </header>

        <div className="flex items-center gap-2 border-b border-[#21262d] px-4 py-3 text-xs">
          {(["decisions", "memory"] as LibraryView[]).map((option) => (
            <button
              key={option}
              onClick={() => setView(option)}
              className={view === option
                ? "rounded border border-cyan-500/40 bg-cyan-500/10 px-2.5 py-1 text-cyan-300"
                : "rounded border border-[#30363d] px-2.5 py-1 text-[#8b949e] hover:text-[#e6edf3]"}
            >
              {option === "decisions" ? "Decisions" : "Project memory"}
            </button>
          ))}
          <span className="ml-auto text-[#6e7681]">{currentItems.length} item{currentItems.length === 1 ? "" : "s"}</span>
        </div>

        {view === "decisions" ? (
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
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2 border-b border-[#21262d] px-4 py-3 sm:grid-cols-4 xl:grid-cols-7">
            {MEMORY_CATEGORIES.map((category) => (
              <button
                key={category.key}
                onClick={() => setMemoryCategory(category.key)}
                title={category.description}
                className={memoryCategory === category.key
                  ? "rounded-lg border border-cyan-500/40 bg-cyan-500/10 p-2 text-left text-cyan-200"
                  : "rounded-lg border border-[#30363d] p-2 text-left text-[#8b949e] hover:bg-[#161b22] hover:text-[#e6edf3]"}
              >
                <span className="block truncate text-[10px] font-medium">{category.label}</span>
                <strong className="mt-1 block text-sm">{memory?.counts[category.key] ?? 0}</strong>
              </button>
            ))}
          </div>
        )}

        {error ? (
          <div className="m-4 rounded border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">{error}</div>
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-[minmax(280px,0.85fr)_minmax(0,1.4fr)]">
            <div className="overflow-y-auto border-r border-[#21262d]">
              {view === "memory" && (
                <div className="border-b border-[#21262d] bg-[#010409] p-3">
                  <p className="text-xs font-medium text-[#c9d1d9]">{selectedCategory.label}</p>
                  <p className="mt-1 text-[11px] leading-4 text-[#6e7681]">{selectedCategory.description}</p>
                </div>
              )}
              {loading && currentItems.length === 0 ? (
                <p className="p-4 text-xs text-[#8b949e]">Loading knowledge…</p>
              ) : currentItems.length === 0 ? (
                <div className="p-4">
                  <p className="text-sm text-[#e6edf3]">Nothing recorded here yet</p>
                  <p className="mt-1 text-xs text-[#8b949e]">Chef only shows durable runtime records. Empty categories stay empty instead of being synthesized.</p>
                </div>
              ) : currentItems.map((decision) => (
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
              <DecisionDetail decision={selected} />
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
    {host && createPortal(<button onClick={() => setOpen(true)} className="header-quiet-button">Knowledge</button>, host)}
    {open && <KnowledgeLibrary onClose={() => setOpen(false)} />}
  </>;
}
