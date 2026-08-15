import type { GraphNode } from "../../src/core/graph.ts";
import { NodeIcon, NODE_LIBRARY } from "./nodeCatalog.tsx";

interface InspectorPanelProps {
  selectedNode: GraphNode | null;
  onAcceptApproval: (node: GraphNode) => void;
  onRejectApproval: (node: GraphNode) => void;
}

function statusClass(status: string | undefined): string {
  switch (status) {
    case "running":
      return "wb-inspector__status--running";
    case "completed":
      return "wb-inspector__status--completed";
    case "failed":
    case "cancelled":
      return "wb-inspector__status--failed";
    case "blocked":
      return "wb-inspector__status--blocked";
    case "spawning":
      return "wb-inspector__status--spawning";
    case "pending":
      return "wb-inspector__status--pending";
    default:
      return "wb-inspector__status--pending";
  }
}

function Field({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="wb-inspector__field">
      <span className="wb-inspector__field-label">{label}</span>
      <span className={mono ? "wb-inspector__field-value wb-inspector__field-value--mono" : "wb-inspector__field-value"}>{value}</span>
    </div>
  );
}

export function InspectorPanel({ selectedNode, onAcceptApproval, onRejectApproval }: InspectorPanelProps) {
  if (!selectedNode) {
    return (
      <div className="wb-inspector__content">
        <div className="wb-inspector__empty">
          <div className="wb-inspector__empty-icon">
            <NodeIcon category="Flow" size={48} />
          </div>
          <p style={{ margin: 0, fontWeight: 500 }}>No node selected</p>
          <p style={{ margin: "4px 0 0", fontSize: 13 }}>Select a node on the canvas to inspect it.</p>
        </div>
      </div>
    );
  }

  const node = selectedNode;
  const isApproval = node.kind === "human" && node.type === "approval";
  const libraryEntry = NODE_LIBRARY.find((entry) => entry.type === node.type);
  const category = libraryEntry?.category ?? (node.kind === "human" ? "Human" : node.kind === "agent" ? "Agents" : "Flow");
  const title = (node.config.title as string | undefined) ?? node.id;

  return (
    <div className="wb-inspector__content">
      <div className="wb-inspector__section">
        <div className="wb-inspector__section-title">
          <NodeIcon category={category} size={14} />
          {isApproval ? "Approval Gate" : libraryEntry?.label ?? title}
        </div>
        <Field label="ID" value={node.id} mono />
        <Field
          label="Status"
          value={
            <span className={`wb-inspector__status ${statusClass(node.status)}`}>{node.status ?? "unknown"}</span>
          }
        />
        {libraryEntry?.description && <Field label="About" value={libraryEntry.description} />}
      </div>

      <div className="wb-inspector__section">
        <div className="wb-inspector__section-title">Configuration</div>
        {Object.entries(node.config).map(([key, value]) => (
          <Field key={key} label={key} value={String(value)} mono={typeof value !== "string" || key === "title" ? false : true} />
        ))}
      </div>

      {isApproval && (
        <div className="wb-inspector__section">
          <div className="wb-inspector__section-title">Review</div>
          <p style={{ margin: "0 0 8px", fontSize: 13, color: "var(--fg-secondary)" }}>
            This task waits for a human decision before execution can continue.
          </p>
          <div className="wb-inspector__actions">
            <button className="wb-btn wb-btn--primary" onClick={() => onAcceptApproval(node)}>
              Accept
            </button>
            <button className="wb-btn wb-btn--danger" onClick={() => onRejectApproval(node)}>
              Reject
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
