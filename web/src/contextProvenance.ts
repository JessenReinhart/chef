export interface ContextReferenceLike {
  type: string;
  id: string;
  relevance?: number;
}

export interface ContextProvenanceSnapshot {
  artifacts: Array<{
    id: string;
    name: string;
    type: string;
    createdBy: string;
    version: number;
  }>;
  decisions: Array<{
    id: string;
    summary: string;
    type: string;
    status: string;
    madeBy: string;
  }>;
  events: Array<{
    id: string;
    seq: number;
    type: string;
    source: { type: string; id: string };
  }>;
  tasks: Array<{
    id: string;
    title: string;
    status: string;
    assignedTo?: string;
  }>;
}

export interface ContextProvenanceDescription {
  label: string;
  detail: string;
  stale: boolean;
  relevance?: number;
}

export function describeContextReference(
  ref: ContextReferenceLike,
  snapshot: ContextProvenanceSnapshot,
): ContextProvenanceDescription {
  const base = { relevance: ref.relevance };

  if (ref.type === "artifact") {
    const artifact = snapshot.artifacts.find((candidate) => candidate.id === ref.id);
    if (!artifact) return { ...base, label: ref.id, detail: "Artifact is no longer present in this workspace", stale: true };
    return {
      ...base,
      label: artifact.name,
      detail: `${artifact.type} artifact · created by ${artifact.createdBy} · v${artifact.version}`,
      stale: false,
    };
  }

  if (ref.type === "decision") {
    const decision = snapshot.decisions.find((candidate) => candidate.id === ref.id);
    if (!decision) return { ...base, label: ref.id, detail: "Decision is no longer present in this workspace", stale: true };
    return {
      ...base,
      label: decision.summary,
      detail: `${decision.type} · ${decision.status} · by ${decision.madeBy}`,
      stale: false,
    };
  }

  if (ref.type === "task") {
    const task = snapshot.tasks.find((candidate) => candidate.id === ref.id);
    if (!task) return { ...base, label: ref.id, detail: "Task is no longer present in this workspace", stale: true };
    return {
      ...base,
      label: task.title,
      detail: `Task · ${task.status}${task.assignedTo ? ` · assigned to ${task.assignedTo}` : ""}`,
      stale: false,
    };
  }

  if (ref.type === "event") {
    const event = snapshot.events.find((candidate) => candidate.id === ref.id);
    if (!event) return { ...base, label: ref.id, detail: "Event is no longer present in this workspace", stale: true };
    return {
      ...base,
      label: event.type,
      detail: `Event #${event.seq} · from ${event.source.type}:${event.source.id}`,
      stale: false,
    };
  }

  // File and message references are valid context types but are not represented
  // in the current UI snapshot. Keep them inspectable without falsely calling
  // them stale merely because this projection cannot resolve them.
  return {
    ...base,
    label: ref.id,
    detail: ref.type === "file" ? "File reference" : "Message reference",
    stale: false,
  };
}
