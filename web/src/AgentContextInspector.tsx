import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "./api";
import { describeContextReference, type ContextProvenanceSnapshot, type ContextReferenceLike } from "./contextProvenance";
import type { ContextZone, UiCanvasNode, UiTask } from "./types";

const MAX_CONTEXT_ROWS = 12;

type ContextRow = {
  key: string;
  sources: string[];
  ref: ContextReferenceLike;
};

type Snapshot = {
  zones: ContextZone[];
  nodes: UiCanvasNode[];
  tasks: UiTask[];
  provenance: ContextProvenanceSnapshot;
};

export function AgentContextInspector() {
  const [target, setTarget] = useState<Element | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const syncSelection = () => {
      const selected = document.querySelector<HTMLElement>(".react-flow__node.selected");
      setSelectedNodeId(selected?.dataset.id ?? null);
      setTarget(document.querySelector(".power-inspector"));
    };
    syncSelection();
    const timer = window.setInterval(syncSelection, 250);
    return () => window.clearInterval(timer);
  }, []);

  const refresh = useCallback(async () => {
    if (!selectedNodeId || !target) return;
    try {
      const [zones, state] = await Promise.all([api.contextZones(), api.stateRaw()]);
      const raw = state as typeof state & Partial<Pick<ContextProvenanceSnapshot, "artifacts" | "decisions">>;
      setSnapshot({
        zones,
        nodes: state.canvasNodes,
        tasks: state.tasks,
        provenance: {
          artifacts: raw.artifacts ?? [],
          decisions: raw.decisions ?? [],
          events: state.events,
          tasks: state.tasks,
        },
      });
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load context");
    }
  }, [selectedNodeId, target]);

  useEffect(() => {
    setSnapshot(null);
    setError(null);
    if (!selectedNodeId || !target) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(timer);
  }, [selectedNodeId, target, refresh]);

  const selectedNode = snapshot?.nodes.find((node) => node.id === selectedNodeId);
  const selectedTask = selectedNode?.taskId
    ? snapshot?.tasks.find((task) => task.id === selectedNode.taskId)
    : undefined;
  const inheritedZones = useMemo(
    () => snapshot?.zones.filter((zone) => selectedNodeId !== null && zone.memberNodeIds.includes(selectedNodeId)) ?? [],
    [snapshot, selectedNodeId],
  );
  const contextAttachments = useMemo(() => {
    const attachments: Array<{ source: string; ref: ContextReferenceLike }> = [];
    for (const zone of inheritedZones) {
      for (const ref of zone.contextRefs) attachments.push({ source: `Shared Context: ${zone.name}`, ref });
    }
    for (const ref of selectedTask?.contextRefs ?? []) attachments.push({ source: "Direct task context", ref });
    return attachments;
  }, [inheritedZones, selectedTask]);
  const rows = useMemo(() => {
    const deduped = new Map<string, ContextRow>();
    for (const attachment of contextAttachments) {
      const key = `${attachment.ref.type}:${attachment.ref.id}`;
      const existing = deduped.get(key);
      if (existing) {
        if (!existing.sources.includes(attachment.source)) existing.sources.push(attachment.source);
        continue;
      }
      deduped.set(key, { key, sources: [attachment.source], ref: attachment.ref });
    }
    return [...deduped.values()].slice(0, MAX_CONTEXT_ROWS);
  }, [contextAttachments]);

  const uniqueCount = new Set(contextAttachments.map(({ ref }) => `${ref.type}:${ref.id}`)).size;
  const attachmentCount = contextAttachments.length;

  if (!target || !selectedNodeId || (snapshot && selectedNode?.kind !== "agent")) return null;

  return createPortal(
    <section aria-label="What this agent knows">
      <h3>What this agent knows</h3>
      <p style={{ margin: "0 0 8px", fontSize: 11, color: "#8b949e" }}>
        Explicit context available through Shared Context membership and this agent's current task.
      </p>
      {error ? (
        <span style={{ color: "#f87171" }}>{error}</span>
      ) : !snapshot ? (
        <span>Loading context…</span>
      ) : rows.length === 0 ? (
        <span>No explicit context references are attached to this agent yet.</span>
      ) : (
        <>
          <div className="power-inspector__chips" style={{ marginBottom: 8 }}>
            <code>{inheritedZones.length} shared zone{inheritedZones.length === 1 ? "" : "s"}</code>
            <code>{uniqueCount} unique reference{uniqueCount === 1 ? "" : "s"}</code>
            {attachmentCount !== uniqueCount && <code>{attachmentCount} attachments</code>}
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            {rows.map((row) => {
              const description = describeContextReference(row.ref, snapshot.provenance);
              return (
                <div key={row.key} style={{ padding: 8, border: "1px solid #30363d", borderRadius: 6, background: "#010409" }}>
                  <div style={{ fontSize: 10, color: "#8b949e", marginBottom: 3 }}>{row.sources.join(" · ")}</div>
                  <strong style={{ display: "block", fontSize: 11 }}>{description.label}</strong>
                  <span style={{ display: "block", marginTop: 2, fontSize: 10, color: description.stale ? "#fbbf24" : "#8b949e" }}>
                    {row.ref.type} · {description.detail}
                    {description.relevance !== undefined ? ` · relevance ${description.relevance.toFixed(2)}` : ""}
                  </span>
                  {description.stale && <span style={{ display: "block", marginTop: 2, fontSize: 10, color: "#fbbf24" }}>Stale or missing source</span>}
                </div>
              );
            })}
          </div>
          {uniqueCount > MAX_CONTEXT_ROWS && <span style={{ display: "block", marginTop: 6 }}>Showing {MAX_CONTEXT_ROWS} of {uniqueCount} unique references.</span>}
        </>
      )}
    </section>,
    target,
  );
}
