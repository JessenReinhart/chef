import { useState, useCallback, useMemo, useEffect } from "react";
import { NODE_LIBRARY, type NodeCatalogEntry, subscribeLibrary } from "./nodeCatalog";
import type { ViewMode } from "./types";

interface PaletteProps {
  onDragStart: (type: string, event: React.DragEvent) => void;
  mode: ViewMode;
}

type PaletteTab = "create" | "artifacts";
type ArtifactType = "file" | "document" | "code" | "image" | "research" | "result";

interface UiArtifact {
  id: string;
  type: ArtifactType;
  name: string;
  uri: string;
  version: number;
  createdBy: string;
  taskId?: string;
  sessionId?: string;
  metadata: Record<string, unknown>;
}

const CATEGORIES = ["All", "Agents", "Tools", "Flow", "Data", "Human"] as const;
const ARTIFACT_TYPES = ["All", "file", "document", "code", "image", "research", "result"] as const;

const CATEGORY_ACCENT: Record<string, string> = {
  All: "text-[#e6edf3]",
  Agents: "text-blue-400",
  Tools: "text-green-400",
  Flow: "text-amber-400",
  Data: "text-violet-400",
  Human: "text-rose-400",
};

const CATEGORY_DOT: Record<string, string> = {
  Agents: "#3b82f6",
  Tools: "#22c55e",
  Flow: "#f59e0b",
  Data: "#a855f7",
  Human: "#f43f5e",
};

const ARTIFACT_DOT: Record<ArtifactType, string> = {
  file: "#8b949e",
  document: "#3b82f6",
  code: "#22c55e",
  image: "#a855f7",
  research: "#06b6d4",
  result: "#f59e0b",
};

const SIMPLE_CATEGORY_LABELS: Record<(typeof CATEGORIES)[number], string> = {
  All: "All",
  Agents: "Teammates",
  Tools: "Apps",
  Flow: "Choices",
  Data: "Files & data",
  Human: "People",
};

const STARTER_TYPE_PREFERENCES = [
  ["harness."],
  ["tool.terminal", "terminal"],
  ["tool.browser", "browser"],
] as const;

function starterEntries(library: NodeCatalogEntry[]): NodeCatalogEntry[] {
  const picked: NodeCatalogEntry[] = [];
  for (const preferences of STARTER_TYPE_PREFERENCES) {
    const match = library.find((entry) =>
      preferences.some((preference) =>
        preference.endsWith(".") ? entry.type.startsWith(preference) : entry.type === preference || entry.type.includes(preference)
      )
    );
    if (match && !picked.some((entry) => entry.type === match.type)) picked.push(match);
  }
  return picked;
}

function metadataSummary(metadata: Record<string, unknown>): string | null {
  const entries = Object.entries(metadata);
  if (entries.length === 0) return null;
  return entries
    .slice(0, 2)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" · ");
}

export function NodePalette({ onDragStart, mode }: PaletteProps) {
  const [tab, setTab] = useState<PaletteTab>("create");
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>("All");
  const [search, setSearch] = useState("");
  const [library, setLibrary] = useState<NodeCatalogEntry[]>(NODE_LIBRARY);
  const [artifacts, setArtifacts] = useState<UiArtifact[]>([]);
  const [artifactType, setArtifactType] = useState<(typeof ARTIFACT_TYPES)[number]>("All");
  const [artifactSearch, setArtifactSearch] = useState("");
  const [artifactError, setArtifactError] = useState<string | null>(null);
  const [artifactLoading, setArtifactLoading] = useState(false);

  useEffect(() => {
    const refresh = () => setLibrary([...NODE_LIBRARY]);
    const unsub = subscribeLibrary(refresh);
    return unsub;
  }, []);

  const refreshArtifacts = useCallback(async () => {
    setArtifactLoading(true);
    try {
      const response = await fetch("/api/artifacts");
      const body = (await response.json()) as { data?: UiArtifact[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      setArtifacts(body.data ?? []);
      setArtifactError(null);
    } catch (error) {
      setArtifactError(error instanceof Error ? error.message : "Failed to load artifacts");
    } finally {
      setArtifactLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab !== "artifacts") return;
    void refreshArtifacts();
    const timer = window.setInterval(() => void refreshArtifacts(), 5000);
    return () => window.clearInterval(timer);
  }, [tab, refreshArtifacts]);

  const filtered = useMemo(
    () =>
      library.filter((node) => {
        if (category !== "All" && node.category !== category) return false;
        if (search) {
          const q = search.toLowerCase();
          return (
            node.label.toLowerCase().includes(q) ||
            node.description.toLowerCase().includes(q) ||
            node.type.toLowerCase().includes(q)
          );
        }
        return true;
      }),
    [library, category, search]
  );

  const filteredArtifacts = useMemo(() => {
    const query = artifactSearch.trim().toLowerCase();
    return artifacts.filter((artifact) => {
      if (artifactType !== "All" && artifact.type !== artifactType) return false;
      if (!query) return true;
      return [artifact.name, artifact.type, artifact.createdBy, artifact.taskId ?? "", artifact.uri]
        .some((value) => value.toLowerCase().includes(query));
    });
  }, [artifacts, artifactSearch, artifactType]);

  const starters = useMemo(() => starterEntries(library), [library]);

  const handleDragStart = useCallback(
    (entry: NodeCatalogEntry, event: React.DragEvent) => {
      const payload = entry.harnessId
        ? JSON.stringify({ type: entry.type, harnessId: entry.harnessId })
        : JSON.stringify({ type: entry.type });
      event.dataTransfer.setData("application/chef-node", payload);
      event.dataTransfer.effectAllowed = "move";
      onDragStart(entry.type, event);
    },
    [onDragStart]
  );

  return (
    <div className="flex flex-col h-full w-56 bg-[#0d1117] border-r border-[#30363d] shrink-0">
      <div className="grid grid-cols-2 gap-1 p-2 border-b border-[#21262d] shrink-0">
        <button
          type="button"
          onClick={() => setTab("create")}
          className={`rounded-md px-2 py-1.5 text-[11px] font-medium transition-colors ${tab === "create" ? "bg-[#21262d] text-[#e6edf3]" : "text-[#8b949e] hover:bg-[#161b22] hover:text-[#e6edf3]"}`}
        >
          {mode === "simple" ? "Add" : "Nodes"}
        </button>
        <button
          type="button"
          onClick={() => setTab("artifacts")}
          className={`rounded-md px-2 py-1.5 text-[11px] font-medium transition-colors ${tab === "artifacts" ? "bg-[#21262d] text-[#e6edf3]" : "text-[#8b949e] hover:bg-[#161b22] hover:text-[#e6edf3]"}`}
        >
          Artifacts {artifacts.length > 0 ? `· ${artifacts.length}` : ""}
        </button>
      </div>

      {tab === "create" ? (
        <>
          <div className="px-3 pt-3 pb-2 border-b border-[#21262d] shrink-0">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-[#8b949e]">{mode === "simple" ? "Add to workspace" : "Nodes"}</h2>
              <span className="text-[10px] text-[#484f58]">{filtered.length}</span>
            </div>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={mode === "simple" ? "Find a teammate or app…" : "Search nodes…"}
              className="w-full bg-[#161b22] border border-[#30363d] rounded-md px-2 py-1.5 text-xs text-[#e6edf3] placeholder-[#8b949e] focus:border-cyan-500 focus:outline-none transition-colors"
            />
          </div>

          {mode === "simple" && starters.length > 0 && (
            <div className="border-b border-[#21262d] px-3 py-2.5 shrink-0">
              <div className="mb-2">
                <div className="text-[11px] font-semibold text-[#e6edf3]">Start here</div>
                <p className="mt-0.5 text-[10px] leading-tight text-[#8b949e]">Drag in a teammate or app. You can connect them later.</p>
              </div>
              <div className="space-y-1.5">
                {starters.map((entry) => (
                  <div
                    key={`starter-${entry.type}`}
                    draggable
                    onDragStart={(e) => handleDragStart(entry, e)}
                    className="group cursor-grab rounded-lg border border-cyan-500/20 bg-cyan-500/[0.04] p-2 transition-all duration-150 hover:border-cyan-400/50 hover:bg-cyan-500/[0.08] active:cursor-grabbing"
                  >
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full shrink-0" style={{ background: CATEGORY_DOT[entry.category] ?? "#6b7280" }} />
                      <span className="truncate text-xs font-semibold text-[#e6edf3]">{entry.label}</span>
                      <span className="ml-auto text-[9px] uppercase tracking-wide text-cyan-400/70">drag</span>
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-[10px] leading-tight text-[#8b949e]">
                      {entry.description.replace(/\s*\([^)]*\)\s*$/, "")}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-1 px-3 pt-2 pb-1 border-b border-[#21262d] shrink-0">
            {CATEGORIES.map((cat) => (
              <button
                key={cat}
                onClick={() => setCategory(cat)}
                className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
                  category === cat
                    ? "bg-[#21262d] text-[#e6edf3] border border-[#30363d]"
                    : "text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#161b22]"
                } ${CATEGORY_ACCENT[cat]}`}
              >
                {mode === "simple" ? SIMPLE_CATEGORY_LABELS[cat] : cat}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-1.5 min-h-0">
            {filtered.length === 0 && (
              <div className="px-2 pt-2">
                <p className="text-xs text-[#8b949e]">Nothing matches yet.</p>
                {(search || category !== "All") && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearch("");
                      setCategory("All");
                    }}
                    className="mt-2 text-[10px] font-medium text-cyan-400 hover:text-cyan-300"
                  >
                    Show everything
                  </button>
                )}
              </div>
            )}
            {filtered.map((entry) => (
              <div
                key={entry.type}
                draggable
                onDragStart={(e) => handleDragStart(entry, e)}
                className="group cursor-grab rounded-lg border border-[#21262d] bg-[#161b22] hover:border-cyan-500/40 hover:bg-[#1c2128] active:cursor-grabbing p-2 transition-all duration-150"
              >
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full shrink-0" style={{ background: CATEGORY_DOT[entry.category] ?? "#6b7280" }} />
                  <span className="text-xs font-semibold truncate">{entry.label}</span>
                  {mode === "power" && entry.harnessId && (
                    <span className="ml-auto h-1.5 w-1.5 rounded-full bg-green-400/60" title={`Harness: ${entry.harnessId}`} />
                  )}
                </div>
                <p className="text-[10px] text-[#8b949e] mt-0.5 leading-tight">
                  {mode === "simple" ? entry.description.replace(/\s*\([^)]*\)\s*$/, "") : entry.description}
                </p>
              </div>
            ))}
            {filtered.length > 0 && (
              <p className="text-[10px] text-[#484f58] px-2 pt-2 text-center">{mode === "simple" ? "Drag anything onto the workspace" : "Drag a node onto the canvas"}</p>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="px-3 pt-3 pb-2 border-b border-[#21262d] shrink-0">
            <div className="flex items-center justify-between mb-2">
              <div>
                <h2 className="text-xs font-semibold uppercase tracking-wider text-[#8b949e]">Artifact shelf</h2>
                <p className="mt-0.5 text-[10px] leading-tight text-[#484f58]">Durable outputs from this workspace.</p>
              </div>
              <button
                type="button"
                onClick={() => void refreshArtifacts()}
                disabled={artifactLoading}
                className="text-[10px] text-cyan-400 hover:text-cyan-300 disabled:text-[#484f58]"
              >
                {artifactLoading ? "Loading…" : "Refresh"}
              </button>
            </div>
            <input
              type="search"
              value={artifactSearch}
              onChange={(event) => setArtifactSearch(event.target.value)}
              placeholder="Find an output…"
              className="w-full bg-[#161b22] border border-[#30363d] rounded-md px-2 py-1.5 text-xs text-[#e6edf3] placeholder-[#8b949e] focus:border-cyan-500 focus:outline-none transition-colors"
            />
          </div>

          <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-[#21262d] shrink-0">
            {ARTIFACT_TYPES.map((type) => (
              <button
                type="button"
                key={type}
                onClick={() => setArtifactType(type)}
                className={`px-1.5 py-0.5 rounded text-[10px] transition-colors ${artifactType === type ? "bg-[#21262d] text-[#e6edf3] border border-[#30363d]" : "text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#161b22]"}`}
              >
                {type === "All" ? "All" : type}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-1.5 min-h-0">
            {artifactError && (
              <div className="rounded-lg border border-red-500/30 bg-red-500/[0.05] p-2 text-[10px] text-red-400">
                {artifactError}
              </div>
            )}
            {!artifactError && !artifactLoading && filteredArtifacts.length === 0 && (
              <div className="px-2 pt-3 text-xs text-[#8b949e]">
                {artifacts.length === 0 ? "No durable outputs yet. Artifacts produced by agents and tools will collect here." : "No artifacts match these filters."}
              </div>
            )}
            {filteredArtifacts.map((artifact) => {
              const summary = metadataSummary(artifact.metadata);
              return (
                <article key={artifact.id} className="rounded-lg border border-[#21262d] bg-[#161b22] p-2">
                  <div className="flex items-start gap-2">
                    <span className="mt-1 h-2 w-2 rounded-full shrink-0" style={{ background: ARTIFACT_DOT[artifact.type] }} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start gap-1">
                        <strong className="truncate text-xs font-semibold text-[#e6edf3]" title={artifact.name}>{artifact.name}</strong>
                        <span className="ml-auto shrink-0 text-[9px] uppercase tracking-wide text-[#6e7681]">v{artifact.version}</span>
                      </div>
                      <div className="mt-0.5 text-[10px] text-[#8b949e]">{artifact.type} · by {artifact.createdBy}</div>
                      {artifact.taskId && <div className="mt-0.5 truncate font-mono text-[9px] text-[#6e7681]">task:{artifact.taskId}</div>}
                      {summary && <div className="mt-1 line-clamp-2 text-[9px] leading-tight text-[#6e7681]">{summary}</div>}
                      <a
                        href={artifact.uri}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1.5 block truncate text-[10px] text-cyan-400 hover:text-cyan-300"
                        title={artifact.uri}
                      >
                        Open artifact ↗
                      </a>
                      {mode === "power" && (
                        <div className="mt-1 truncate font-mono text-[9px] text-[#484f58]" title={artifact.id}>id:{artifact.id}</div>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
