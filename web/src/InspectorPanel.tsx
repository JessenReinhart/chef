import { useEffect, useState } from "react";
import type { GraphNode } from "../../src/core/graph.ts";
import { NodeIcon, NODE_LIBRARY } from "./nodeCatalog.tsx";
import { SimpleConfigRenderer, mapRuntimeToSimple, mapSimpleToRuntime } from "./simpleNodeConfig.tsx";

interface InspectorPanelProps {
  selectedNode: GraphNode | null;
  onAcceptApproval: (node: GraphNode) => void;
  onRejectApproval: (node: GraphNode) => void;
  mode: "simple" | "power";
  onConfigChange: (nodeId: string, key: string, value: unknown) => void;
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

function formatConfigValue(value: unknown): string {
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function parseConfigValue(draft: string, original: unknown): unknown {
  if (original === null || typeof original === "object") return JSON.parse(draft);

  if (typeof original === "number") {
    const value = Number(draft);
    if (!Number.isFinite(value)) throw new Error("Enter a finite number.");
    return value;
  }

  if (typeof original === "boolean") {
    if (draft === "true") return true;
    if (draft === "false") return false;
    throw new Error('Enter either "true" or "false".');
  }

  return draft;
}

function PowerConfigField({
  configKey,
  value,
  onSave,
}: {
  configKey: string;
  value: unknown;
  onSave: (value: unknown) => void;
}) {
  const formatted = formatConfigValue(value);
  const [draft, setDraft] = useState(formatted);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(formatted);
    setError(null);
  }, [formatted]);

  const isStructured = value === null || typeof value === "object";
  const dirty = draft !== formatted;

  const save = () => {
    try {
      onSave(parseConfigValue(draft, value));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Invalid value.");
    }
  };

  return (
    <div className="wb-inspector__field wb-inspector__field--power">
      <label className="wb-inspector__label" htmlFor={`config-${configKey}`}>{configKey}</label>
      {isStructured ? (
        <textarea
          id={`config-${configKey}`}
          className="wb-inspector__input wb-inspector__input--mono"
          value={draft}
          rows={Math.min(10, Math.max(3, draft.split("\n").length))}
          onChange={(event) => setDraft(event.target.value)}
        />
      ) : (
        <input
          id={`config-${configKey}`}
          className="wb-inspector__input wb-inspector__input--mono"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && dirty) save();
          }}
        />
      )}
      {error && <span className="wb-inspector__field-value" style={{ color: "var(--danger, #c44)" }}>{error}</span>}
      {dirty && (
        <div className="wb-inspector__actions">
          <button className="wb-btn wb-btn--primary" onClick={save}>Save</button>
          <button
            className="wb-btn"
            onClick={() => {
              setDraft(formatted);
              setError(null);
            }}
          >
            Reset
          </button>
        </div>
      )}
    </div>
  );
}

export function InspectorPanel({ selectedNode, onAcceptApproval, onRejectApproval, mode, onConfigChange }: InspectorPanelProps) {
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
        {mode === "simple" ? (
          <SimpleConfigRenderer
            node={node}
            mode={mode}
            values={mapRuntimeToSimple(node.type, node.config as Record<string, unknown>)}
            onChange={(key, value) => {
              const runtimeUpdates = mapSimpleToRuntime(node.type, { [key]: value });
              Object.entries(runtimeUpdates).forEach(([k, v]) => onConfigChange(node.id, k, v));
            }}
          />
        ) : (
          <div className="wb-inspector__section wb-inspector__section--power">
            {Object.entries(node.config).map(([key, value]) => (
              <PowerConfigField
                key={key}
                configKey={key}
                value={value}
                onSave={(nextValue) => onConfigChange(node.id, key, nextValue)}
              />
            ))}
          </div>
        )}
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
