/**
 * Chef Workbench — node library catalog.
 *
 * A projection-side vocabulary of node types a user can compose on the
 * canvas. The runtime remains authoritative: library entries describe
 * intent; the actual graph is built from workspace state.
 */

export interface NodeCatalogEntry {
  /** Stable node type id (matches GraphNode.type vocabulary where it exists). */
  type: string;
  /** Human-readable name shown in the library and on canvas nodes. */
  label: string;
  /** One-line description for the library tooltip / inspector. */
  description: string;
  /** Visual category, also used to group the library list. */
  category: "Agents" | "Tools" | "Flow" | "Data" | "Human";
  /** Maps to GraphNodeKind when the node becomes part of a graph. */
  kind: "agent" | "tool" | "control" | "workflow" | "human";
  /** True when the runtime can already produce/consume this node type. */
  implemented: boolean;
}

export const NODE_LIBRARY: NodeCatalogEntry[] = [
  {
    type: "task",
    label: "Agent Task",
    description: "An LLM-powered reasoning or execution step.",
    category: "Agents",
    kind: "agent",
    implemented: true,
  },
  {
    type: "approval",
    label: "Approval Gate",
    description: "A human checkpoint that holds execution until approved.",
    category: "Human",
    kind: "human",
    implemented: true,
  },
  {
    type: "terminal",
    label: "Terminal",
    description: "A real shell / command execution surface.",
    category: "Tools",
    kind: "tool",
    implemented: false,
  },
  {
    type: "file",
    label: "File / Data",
    description: "Read structured or unstructured data from files.",
    category: "Data",
    kind: "tool",
    implemented: false,
  },
  {
    type: "browser",
    label: "Browser",
    description: "Web research and interaction.",
    category: "Tools",
    kind: "tool",
    implemented: false,
  },
  {
    type: "transform",
    label: "Transform",
    description: "Clean, map, or aggregate data.",
    category: "Data",
    kind: "tool",
    implemented: false,
  },
  {
    type: "logic",
    label: "Logic",
    description: "Branch, loop, or condition on values.",
    category: "Flow",
    kind: "control",
    implemented: false,
  },
  {
    type: "output",
    label: "Output",
    description: "Produce or deliver results.",
    category: "Flow",
    kind: "workflow",
    implemented: false,
  },
];

/** Tiny inline SVG icons keyed by node category (stroke inherits currentColor). */
export function NodeIcon({
  category,
  size = 16,
  style,
}: {
  category: NodeCatalogEntry["category"];
  size?: number;
  style?: React.CSSProperties;
}) {
  const common: React.SVGProps<SVGSVGElement> = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
    ...(style as React.SVGProps<SVGSVGElement>),
  };
  switch (category) {
    case "Agents":
      return (
        <svg {...common}>
          <circle cx="12" cy="7" r="3.2" />
          <path d="M6.5 19.5v-1.2a5.5 5.5 0 0 1 11 0v1.2" />
        </svg>
      );
    case "Tools":
      return (
        <svg {...common}>
          <path d="M14.7 6.3a4.5 4.5 0 0 0-6 5.7L3 17.8V21h3.2l5.8-5.7a4.5 4.5 0 0 0 5.7-6l-3.4 3.4-3.1-.7-.7-3.1z" />
        </svg>
      );
    case "Flow":
      return (
        <svg {...common}>
          <path d="M5 8h10a3 3 0 0 1 0 6H9a3 3 0 0 0 0 6h10" />
          <path d="M5 8l-2 2m2-2l2 2" />
        </svg>
      );
    case "Data":
      return (
        <svg {...common}>
          <ellipse cx="12" cy="6" rx="7.5" ry="3" />
          <path d="M4.5 6v12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6" />
          <path d="M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3" />
        </svg>
      );
    case "Human":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M8.5 15.5c.8-1.6 2-2.4 3.5-2.4s2.7.8 3.5 2.4" />
          <circle cx="9.3" cy="10.2" r="0.9" fill="currentColor" stroke="none" />
          <circle cx="14.7" cy="10.2" r="0.9" fill="currentColor" stroke="none" />
        </svg>
      );
  }
}
