import type { NodeKind, HarnessInfo, NodeCatalogEntry } from "./types";

export type { NodeCatalogEntry };

/**
 * Static tool entries (always available).
 */
const STATIC_TOOLS: Omit<NodeCatalogEntry, "harnessId">[] = [
  { type: "tool.terminal", label: "Terminal", description: "Run a shell command", category: "Tools", kind: "tool", accent: "green", icon: ">_" },
  { type: "tool.browser", label: "Browser", description: "Web research & interaction", category: "Tools", kind: "tool", accent: "green", icon: "🌐" },
  { type: "tool.file", label: "File", description: "Read or write a data file", category: "Data", kind: "tool", accent: "green", icon: "📄" },
  { type: "tool.transform", label: "Transform", description: "Clean, map, or aggregate data", category: "Data", kind: "tool", accent: "green", icon: "⟳" },
  { type: "control.logic", label: "Logic", description: "Branch or condition on values", category: "Flow", kind: "control", accent: "amber", icon: "◇" },
  { type: "workflow.output", label: "Output", description: "Produce & deliver results", category: "Flow", kind: "workflow", accent: "purple", icon: "□" },
  { type: "human.approval", label: "Approval Gate", description: "Pause until a human approves", category: "Human", kind: "human", accent: "rose", icon: "⌂" },
];

/**
 * Harness type → icon + kind mapping.
 */
const HARNESS_ICONS: Record<string, { icon: string; kind: NodeKind }> = {
  "claude-code": { icon: "▣", kind: "agent" },
  "omp": { icon: "⬢", kind: "agent" },
  "freebuff": { icon: "⬡", kind: "agent" },
  "pi": { icon: "π", kind: "agent" },
  "generic": { icon: ">_", kind: "tool" },
};

/**
 * Build the full node library from harnesses + static tools.
 */
function buildLibrary(harnesses: HarnessInfo[]): NodeCatalogEntry[] {
  const library: NodeCatalogEntry[] = [];
  for (const h of harnesses) {
    if (!h.available) continue;
    const mapping = HARNESS_ICONS[h.id] ?? { icon: "◆", kind: "agent" };
    library.push({
      type: `harness.${h.id}`,
      label: h.name,
      description: `${h.name} agent (${h.type})`,
      category: "Agents",
      kind: mapping.kind,
      accent: "cyan",
      harnessId: h.id,
      icon: mapping.icon,
    });
  }
  for (const t of STATIC_TOOLS) {
    library.push({ ...t });
  }
  return library;
}

/**
 * Node palette — what you can drag onto the canvas.
 * Harness entries are registered asynchronously from GET /api/harnesses
 * via `registerHarnesses`; static tools are always present.
 */
export const NODE_LIBRARY: NodeCatalogEntry[] = buildLibrary([]);

const listeners = new Set<() => void>();

/** Rebuild NODE_LIBRARY from freshly fetched harnesses and notify subscribers. */
export function registerHarnesses(harnesses: HarnessInfo[]): void {
  NODE_LIBRARY.length = 0;
  NODE_LIBRARY.push(...buildLibrary(harnesses));
  for (const listener of listeners) listener();
}

/** Subscribe to NODE_LIBRARY rebuilds (returns unsubscribe). */
export function subscribeLibrary(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Lookup a palette entry by node type. */
export function catalogEntry(type: string): NodeCatalogEntry | undefined {
  return NODE_LIBRARY.find((n) => n.type === type);
}

/**
 * Color mapping by kind (Blueprint node header accents).
 */
export const KIND_COLORS: Record<NodeKind, string> = {
  agent: "#3b82f6",
  tool: "#22c55e",
  control: "#f59e0b",
  workflow: "#a855f7",
  human: "#f43f5e",
};

/**
 * Status → color mapping.
 */
export const STATUS_COLORS: Record<string, string> = {
  pending: "#6b7280",
  assigned: "#8b5cf6",
  running: "#22c55e",
  completed: "#3b82f6",
  failed: "#ef4444",
  blocked: "#f59e0b",
  cancelled: "#9ca3af",
  spawning: "#eab308",
};

/**
 * Category accent colors for palette tabs.
 */
export const CATEGORY_ACCENT: Record<string, string> = {
  All: "text-[#e6edf3]",
  Agents: "text-cyan-400",
  Tools: "text-green-400",
  Flow: "text-amber-400",
  Data: "text-violet-400",
  Human: "text-rose-400",
};
