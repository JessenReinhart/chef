import { useState, useCallback, useMemo, useEffect } from "react";
import { NODE_LIBRARY, catalogEntry, type NodeCatalogEntry, subscribeLibrary } from "./nodeCatalog";
import type { ViewMode } from "./types";

interface PaletteProps {
  onDragStart: (type: string, event: React.DragEvent) => void;
  mode: ViewMode;
}

const CATEGORIES = ["All", "Agents", "Tools", "Flow", "Data", "Human"] as const;

const CATEGORY_ACCENT: Record<string, string> = {
  All: "text-[#e6edf3]",
  Agents: "text-blue-400",
  Tools: "text-green-400",
  Flow: "text-amber-400",
  Data: "text-violet-400",
  Human: "text-rose-400",
};

/** Category accent colors for the colored dot on each card. */
const CATEGORY_DOT: Record<string, string> = {
  Agents: "#3b82f6",
  Tools: "#22c55e",
  Flow: "#f59e0b",
  Data: "#a855f7",
  Human: "#f43f5e",
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

export function NodePalette({ onDragStart, mode }: PaletteProps) {
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>("All");
  const [search, setSearch] = useState("");
  const [library, setLibrary] = useState<NodeCatalogEntry[]>(NODE_LIBRARY);

  // Subscribe to harness-driven library rebuilds (registerHarnesses notifies).
  useEffect(() => {
    const refresh = () => setLibrary([...NODE_LIBRARY]);
    const unsub = subscribeLibrary(refresh);
    return unsub;
  }, []);

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

  const starters = useMemo(() => starterEntries(library), [library]);

  const handleDragStart = useCallback(
    (entry: NodeCatalogEntry, event: React.DragEvent) => {
      // Drag payload: JSON with type + harnessId (for harness.* entries).
      // This mirrors the contract FrontendBlueprint set.
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
      {/* Header + search */}
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

      {/* Category tabs */}
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

      {/* Node list — draggable cards */}
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
    </div>
  );
}
