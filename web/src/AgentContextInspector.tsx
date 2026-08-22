import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { describeContextReference, type ContextProvenanceSnapshot, type ContextReferenceLike } from "./contextProvenance";
import type { ContextZone, UiTask } from "./types";

const MAX_CONTEXT_ROWS = 12;

type ContextRow = {
  key: string;
  source: string;
  ref: ContextReferenceLike;
};

type Snapshot = {
  zones: ContextZone[];
  tasks: UiTask[];
  provenance: ContextProvenanceSnapshot;
};

export function AgentContextInspector({ nodeId, taskId }: { nodeId: string; taskId?: string }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [zones, state] = await Promise.all([api.contextZones(), api.stateRaw()]);
        if (cancelled) return;
        const raw = state as typeof state & Pick<ContextProvenanceSnapshot, "artifacts" | "decisions">;
        setSnapshot({
          zones,
          tasks: state.tasks,
          provenance: { artifacts: raw.artifacts, decisions: raw.decisions, events: state.events, tasks: state.tasks },
        });
        setError(null);
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load context");
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [nodeId, taskId]);

  const rows = useMemo(() => {
    if (!snapshot) return [] as ContextRow[];
    const result: ContextRow[] = [];
    for (const zone of snapshot.zones.filter((candidate) => candidate.memberNodeIds.includes(nodeId))) {
      for (const ref of zone.contextRefs) {
        result.push({ key: `zone:${zone.id}:${ref.type}:${ref.id}`, source: `Shared Context: ${zone.name}`, ref });
      }
    }
    const task = taskId ? snapshot.tasks.find((candidate) => candidate.id === taskId) : undefined;
    for (const ref of task?.contextRefs ?? []) {
      result.push({ key: `task:${task?.id}:${ref.type}:${ref.id}`, source: "Direct task context", ref });
    }
    return result.slice(0, MAX_CONTEXT_ROWS);
  }, [snapshot, nodeId, taskId]);

  const zoneCount = snapshot?.zones.filter((candidate) => candidate.memberNodeIds.includes(nodeId)).length ?? 0;
  const totalCount = useMemo(() => {
    if (!snapshot) return 0;
    const inherited = snapshot.zones
      .filter((candidate) => candidate.memberNodeIds.includes(nodeId))
      .reduce((sum, zone) => sum + zone.contextRefs.length, 0);
    const task = taskId ? snapshot.tasks.find((candidate) => candidate.id === taskId) : undefined;
    return inherited + (task?.contextRefs?.length ?? 0);
  }, [snapshot, nodeId, taskId]);

  return (
    <div className="wb-inspector__section" aria-label="What this agent knows">
      <div className="wb-inspector__section-title">What this agent knows</div>
      <p style={{ margin: "0 0 8px", fontSize: 12, color: "var(--fg-secondary)" }}>
        Runtime-owned context references currently available to this agent through explicit Shared Context membership or its task.
      </p>
      {error ? (
        <span className="wb-inspector__field-value" style={{ color: "var(--danger, #c44)" }}>{error}</span>
      ) : !snapshot ? (
        <span className="wb-inspector__field-value">Loading context…</span>
      ) : rows.length === 0 ? (
        <span className="wb-inspector__field-value">No explicit context references are attached to this agent yet.</span>
      ) : (
        <>
          <div className="wb-inspector__field">
            <span className="wb-inspector__field-label">Sources</span>
            <span className="wb-inspector__field-value">{zoneCount} Shared Context zone{zoneCount === 1 ? "" : "s"} · {totalCount} reference{totalCount === 1 ? "" : "s"}</span>
          </div>
          {rows.map((row) => {
            const description = describeContextReference(row.ref, snapshot.provenance);
            return (
              <div key={row.key} className="wb-inspector__field">
                <span className="wb-inspector__field-label">{row.source}</span>
                <span className="wb-inspector__field-value">
                  <strong>{description.label}</strong>
                  <br />
                  <span>{row.ref.type} · {description.detail}{description.relevance !== undefined ? ` · relevance ${description.relevance.toFixed(2)}` : ""}</span>
                  {description.stale && <><br /><span style={{ color: "var(--warning, #b88700)" }}>Stale or missing source</span></>}
                </span>
              </div>
            );
          })}
          {totalCount > MAX_CONTEXT_ROWS && (
            <span className="wb-inspector__field-value">Showing {MAX_CONTEXT_ROWS} of {totalCount} references.</span>
          )}
        </>
      )}
    </div>
  );
}
