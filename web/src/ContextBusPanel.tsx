import { useEffect, useState, useMemo } from "react";
import type { ContextReference, Artifact, Decision, RuntimeEvent, Task } from "../../src/core/types.ts";
import type { GraphNode } from "../../src/core/graph.ts";

interface ContextBusPanelProps {
  selectedNode: GraphNode | null;
  snapshotTasks: Task[];
  snapshotArtifacts: Artifact[];
  snapshotDecisions: Decision[];
  snapshotEvents: RuntimeEvent[];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTimestamp(ts: number): string {
  const date = new Date(ts);
  return date.toLocaleString();
}

function getArtifactIcon(type: string): string {
  switch (type) {
    case "file": return "📄";
    case "document": return "📝";
    case "code": return "💻";
    case "image": return "🖼️";
    case "research": return "🔍";
    case "result": return "📊";
    default: return "📦";
  }
}

function getDecisionStatusColor(status: string): string {
  switch (status) {
    case "accepted": return "var(--accent-green)";
    case "rejected": return "var(--accent-red)";
    default: return "var(--accent-gold)";
  }
}

function getDecisionStatusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function ContextBusPanel({
  selectedNode,
  snapshotTasks,
  snapshotArtifacts,
  snapshotDecisions,
  snapshotEvents,
}: ContextBusPanelProps) {
  const [activeTab, setActiveTab] = useState<"refs" | "artifacts" | "decisions" | "events">("refs");

  const nodeContextRefs = useMemo(() => {
    if (!selectedNode) return [] as ContextReference[];
    const task = snapshotTasks.find((t) => t.id === selectedNode.taskId);
    return task?.contextRefs ?? [];
  }, [selectedNode, snapshotTasks]);

  const nodeArtifacts = useMemo(() => {
    if (!selectedNode) return [] as Artifact[];
    return snapshotArtifacts.filter((a) => a.taskId === selectedNode.taskId || a.sessionId === selectedNode.config.sessionId);
  }, [selectedNode, snapshotArtifacts]);

  const nodeDecisions = useMemo(() => {
    if (!selectedNode) return [] as Decision[];
    return snapshotDecisions.filter((d) => {
      const task = snapshotTasks.find((t) => t.id === selectedNode?.taskId);
      return task && d.payload && typeof d.payload === "object" && "taskId" in d.payload && (d.payload as Record<string, unknown>).taskId === task.id;
    });
  }, [selectedNode, snapshotDecisions, snapshotTasks]);

  const nodeEvents = useMemo(() => {
    if (!selectedNode) return [] as RuntimeEvent[];
    return snapshotEvents.filter((e) => e.taskId === selectedNode.taskId);
  }, [selectedNode, snapshotEvents]);

  const allArtifacts = useMemo(() => snapshotArtifacts, [snapshotArtifacts]);
  const allDecisions = useMemo(() => snapshotDecisions, [snapshotDecisions]);
  const allEvents = useMemo(() => snapshotEvents.slice(-100), [snapshotEvents]);

  return (
    <div className="wb-context-bus" role="region" aria-label="Context Bus">
      <div className="wb-context-bus__header">
        <h3 className="wb-context-bus__title">Context Bus</h3>
        <div className="wb-context-bus__tabs" role="tablist">
          <button
            role="tab"
            aria-selected={activeTab === "refs"}
            className={`wb-context-bus__tab ${activeTab === "refs" ? "wb-context-bus__tab--active" : ""}`}
            onClick={() => setActiveTab("refs")}
          >
            Refs ({nodeContextRefs.length})
          </button>
          <button
            role="tab"
            aria-selected={activeTab === "artifacts"}
            className={`wb-context-bus__tab ${activeTab === "artifacts" ? "wb-context-bus__tab--active" : ""}`}
            onClick={() => setActiveTab("artifacts")}
          >
            Artifacts ({nodeArtifacts.length})
          </button>
          <button
            role="tab"
            aria-selected={activeTab === "decisions"}
            className={`wb-context-bus__tab ${activeTab === "decisions" ? "wb-context-bus__tab--active" : ""}`}
            onClick={() => setActiveTab("decisions")}
          >
            Decisions ({nodeDecisions.length})
          </button>
          <button
            role="tab"
            aria-selected={activeTab === "events"}
            className={`wb-context-bus__tab ${activeTab === "events" ? "wb-context-bus__tab--active" : ""}`}
            onClick={() => setActiveTab("events")}
          >
            Events ({nodeEvents.length})
          </button>
        </div>
      </div>

      <div className="wb-context-bus__content">
        {activeTab === "refs" && (
          <div className="wb-context-bus__panel" role="tabpanel">
            {nodeContextRefs.length === 0 ? (
              <div className="wb-context-bus__empty">No context references for this node</div>
            ) : (
              <ul className="wb-context-bus__refs-list">
                {nodeContextRefs.map((ref) => (
                  <li key={ref.id} className="wb-context-bus__ref-item">
                    <span className="wb-context-bus__ref-type">{ref.type}</span>
                    <span className="wb-context-bus__ref-id">{ref.id.slice(0, 16)}…</span>
                    {ref.relevance !== undefined && (
                      <span className="wb-context-bus__ref-meta">relevance: {ref.relevance.toFixed(2)}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {activeTab === "artifacts" && (
          <div className="wb-context-bus__panel" role="tabpanel">
            {nodeArtifacts.length === 0 && allArtifacts.length === 0 ? (
              <div className="wb-context-bus__empty">No artifacts in workspace</div>
            ) : nodeArtifacts.length === 0 ? (
              <div className="wb-context-bus__empty">
                No artifacts for this node. Showing all workspace artifacts:
                <ul className="wb-context-bus__artifacts-list">
                  {allArtifacts.map((artifact) => (
                    <li key={artifact.id} className="wb-context-bus__artifact-item">
                      <span className="wb-context-bus__artifact-icon">{getArtifactIcon(artifact.type)}</span>
                      <div className="wb-context-bus__artifact-info">
                        <span className="wb-context-bus__artifact-name">{artifact.name}</span>
                        <span className="wb-context-bus__artifact-meta">
                          {artifact.type} · {formatBytes(JSON.stringify(artifact.metadata).length)} · {artifact.version} versions
                        </span>
                      </div>
                      {artifact.uri && (
                        <a href={artifact.uri} target="_blank" rel="noopener noreferrer" className="wb-btn wb-btn--ghost wb-btn--sm">
                          Open
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <ul className="wb-context-bus__artifacts-list">
                {nodeArtifacts.map((artifact) => (
                  <li key={artifact.id} className="wb-context-bus__artifact-item">
                    <span className="wb-context-bus__artifact-icon">{getArtifactIcon(artifact.type)}</span>
                    <div className="wb-context-bus__artifact-info">
                      <span className="wb-context-bus__artifact-name">{artifact.name}</span>
                      <span className="wb-context-bus__artifact-meta">
                        {artifact.type} · {formatBytes(JSON.stringify(artifact.metadata).length)} · v{artifact.version}
                      </span>
                    </div>
                    {artifact.uri && (
                      <a href={artifact.uri} target="_blank" rel="noopener noreferrer" className="wb-btn wb-btn--ghost wb-btn--sm">
                        Open
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {activeTab === "decisions" && (
          <div className="wb-context-bus__panel" role="tabpanel">
            {nodeDecisions.length === 0 && allDecisions.length === 0 ? (
              <div className="wb-context-bus__empty">No decisions in workspace</div>
            ) : nodeDecisions.length === 0 ? (
              <div className="wb-context-bus__empty">
                No decisions for this node. Showing all workspace decisions:
                <ul className="wb-context-bus__decisions-list">
                  {allDecisions.map((decision) => (
                    <li key={decision.id} className="wb-context-bus__decision-item">
                      <span
                        className="wb-context-bus__decision-status"
                        style={{ background: getDecisionStatusColor(decision.status) }}
                      >
                        {getDecisionStatusLabel(decision.status)}
                      </span>
                      <div className="wb-context-bus__decision-info">
                        <span className="wb-context-bus__decision-summary">{decision.summary}</span>
                        <span className="wb-context-bus__decision-meta">
                          {decision.type} · by {decision.madeBy} · {formatTimestamp(decision.timestamp)}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <ul className="wb-context-bus__decisions-list">
                {nodeDecisions.map((decision) => (
                  <li key={decision.id} className="wb-context-bus__decision-item">
                    <span
                      className="wb-context-bus__decision-status"
                      style={{ background: getDecisionStatusColor(decision.status) }}
                    >
                      {getDecisionStatusLabel(decision.status)}
                    </span>
                    <div className="wb-context-bus__decision-info">
                      <span className="wb-context-bus__decision-summary">{decision.summary}</span>
                      <span className="wb-context-bus__decision-meta">
                        {decision.type} · by {decision.madeBy} · {formatTimestamp(decision.timestamp)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {activeTab === "events" && (
          <div className="wb-context-bus__panel" role="tabpanel">
            {nodeEvents.length === 0 ? (
              <div className="wb-context-bus__empty">No events for this node</div>
            ) : (
              <ul className="wb-context-bus__events-list">
                {nodeEvents.slice().reverse().map((event) => (
                  <li key={event.id} className="wb-context-bus__event-item">
                    <span className="wb-context-bus__event-time">
                      {new Date(event.timestamp).toLocaleTimeString()}
                    </span>
                    <span className="wb-context-bus__event-type">{event.type}</span>
                    <span className="wb-context-bus__event-payload">
                      {typeof event.payload === "string"
                        ? event.payload.slice(0, 80)
                        : JSON.stringify(event.payload).slice(0, 80)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {selectedNode && (
        <div className="wb-context-bus__node-info">
          <span className="wb-context-bus__node-label">Node:</span>
          <span className="wb-context-bus__node-id">{selectedNode.id}</span>
          <span className="wb-context-bus__node-task">Task: {selectedNode.taskId ?? "—"}</span>
        </div>
      )}
    </div>
  );
}