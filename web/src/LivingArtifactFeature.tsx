import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import "./living-artifact.css";
import "./artifact-preview.css";

type ArtifactType = "file" | "document" | "code" | "image" | "research" | "result";

type LivingArtifact = {
  id: string;
  workspaceId: string;
  type: ArtifactType;
  name: string;
  uri: string;
  version: number;
  createdBy: string;
  taskId?: string;
  sessionId?: string;
  metadata: Record<string, unknown>;
};

const MAX_VISIBLE_RESULTS = 4;
const MAX_SHELF_RESULTS = 24;
const MAX_PREVIEW_LENGTH = 800;
const MAX_METADATA_ROWS = 8;
const SPATIAL_RESULT_SLOTS = ["near", "upper", "outer", "lower"] as const;

function artifactIcon(type: ArtifactType): string {
  switch (type) {
    case "image": return "◫";
    case "code": return "</>";
    case "research": return "⌕";
    case "document": return "▤";
    case "file": return "▧";
    default: return "✦";
  }
}

function artifactLabel(type: ArtifactType): string {
  switch (type) {
    case "research": return "Research";
    case "document": return "Document";
    case "code": return "Code";
    case "image": return "Image";
    case "file": return "File";
    default: return "Result";
  }
}

function canDownload(artifact: LivingArtifact): boolean {
  return artifact.uri.startsWith("file:");
}

function provenanceLabel(artifact: LivingArtifact): string {
  const task = artifact.taskId ? ` · task ${artifact.taskId.slice(0, 8)}` : "";
  return `v${artifact.version} · by ${artifact.createdBy}${task}`;
}

function previewText(artifact: LivingArtifact): string | null {
  const candidate = artifact.metadata.preview
    ?? artifact.metadata.summary
    ?? artifact.metadata.description
    ?? artifact.metadata.content;
  if (typeof candidate !== "string" || candidate.trim().length === 0) return null;
  const text = candidate.trim();
  return text.length > MAX_PREVIEW_LENGTH ? `${text.slice(0, MAX_PREVIEW_LENGTH)}…` : text;
}

function metadataRows(artifact: LivingArtifact): Array<[string, string]> {
  return Object.entries(artifact.metadata)
    .filter(([key]) => !["preview", "summary", "description", "content"].includes(key))
    .flatMap(([key, value]) => {
      if (value === null || value === undefined) return [];
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return [[key, String(value)] as [string, string]];
      }
      return [];
    })
    .slice(0, MAX_METADATA_ROWS);
}

export function LivingArtifactFeature() {
  const [enabled, setEnabled] = useState(() => localStorage.getItem("chef:view-mode") !== "power");
  const [artifacts, setArtifacts] = useState<LivingArtifact[]>([]);
  const [target, setTarget] = useState<Element | null>(null);
  const [shelfOpen, setShelfOpen] = useState(false);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setEnabled(localStorage.getItem("chef:view-mode") !== "power");
    }, 250);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setTarget(null);
      setShelfOpen(false);
      setSelectedArtifactId(null);
      return;
    }
    const findTarget = () => setTarget(document.querySelector(".chef-living-stage"));
    findTarget();
    const timer = window.setInterval(findTarget, 500);
    return () => window.clearInterval(timer);
  }, [enabled]);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const response = await fetch("/api/artifacts");
      if (!response.ok) return;
      const body = await response.json() as { ok?: boolean; data?: LivingArtifact[] };
      if (body.ok && Array.isArray(body.data)) setArtifacts(body.data);
    } catch {
      // Artifact cards are an optional projection. Keep the workspace usable.
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(timer);
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled) return;
    const stream = new EventSource("/api/events?types=artifact.*");
    stream.onmessage = () => void refresh();
    return () => stream.close();
  }, [enabled, refresh]);

  const visibleArtifacts = useMemo(
    () => artifacts.slice(-MAX_VISIBLE_RESULTS).reverse(),
    [artifacts],
  );
  const shelfArtifacts = useMemo(
    () => artifacts.slice(-MAX_SHELF_RESULTS).reverse(),
    [artifacts],
  );
  const selectedArtifact = useMemo(
    () => artifacts.find((artifact) => artifact.id === selectedArtifactId) ?? null,
    [artifacts, selectedArtifactId],
  );

  if (!enabled || !target || visibleArtifacts.length === 0) return null;

  const inspectArtifact = (artifact: LivingArtifact) => {
    setShelfOpen(true);
    setSelectedArtifactId(artifact.id);
  };

  return createPortal(
    <section className="chef-result-cluster" aria-label="Workspace results">
      <div className="chef-result-cluster__label">
        <span>Results</span>
        <small>{artifacts.length}</small>
      </div>
      {visibleArtifacts.map((artifact, index) => (
        <article
          key={`${artifact.id}:${artifact.version}`}
          className="chef-result-card"
          data-result-slot={SPATIAL_RESULT_SLOTS[index]}
          style={{ "--chef-result-index": index } as CSSProperties}
        >
          <button className="chef-result-card__inspect" type="button" onClick={() => inspectArtifact(artifact)} aria-label={`Inspect ${artifact.name}`}>
            <div className="chef-result-card__icon" aria-hidden="true">{artifactIcon(artifact.type)}</div>
            <div className="chef-result-card__body">
              <span className="chef-result-card__eyebrow">{artifactLabel(artifact.type)}</span>
              <strong title={artifact.name}>{artifact.name}</strong>
              <small title={provenanceLabel(artifact)}>{provenanceLabel(artifact)}</small>
            </div>
          </button>
          {canDownload(artifact) ? (
            <a
              className="chef-result-card__action"
              href={`/api/artifacts/${encodeURIComponent(artifact.id)}/download`}
              download
              title={`Download ${artifact.name}`}
            >
              ↓
            </a>
          ) : (
            <span className="chef-result-card__ready" title="Stored in Chef">✓</span>
          )}
        </article>
      ))}

      {artifacts.length > MAX_VISIBLE_RESULTS && (
        <button
          className="chef-result-cluster__more"
          type="button"
          aria-expanded={shelfOpen}
          aria-controls="chef-artifact-shelf"
          onClick={() => setShelfOpen((open) => !open)}
        >
          {shelfOpen ? "Hide result shelf" : "Open result shelf"}
        </button>
      )}

      {shelfOpen && (
        <div id="chef-artifact-shelf" className="chef-artifact-shelf" role="region" aria-label="Artifact shelf">
          <div className="chef-artifact-shelf__header">
            <div>
              <strong>Artifact shelf</strong>
              <span>Durable outputs from this workspace</span>
            </div>
            <button type="button" onClick={() => { setShelfOpen(false); setSelectedArtifactId(null); }} aria-label="Close artifact shelf">×</button>
          </div>
          {selectedArtifact && (
            <section className="chef-artifact-preview" aria-label={`Artifact preview for ${selectedArtifact.name}`}>
              <div className="chef-artifact-preview__heading">
                <div>
                  <span>{artifactLabel(selectedArtifact.type)} preview</span>
                  <strong>{selectedArtifact.name}</strong>
                  <small>{provenanceLabel(selectedArtifact)}</small>
                </div>
                <button type="button" onClick={() => setSelectedArtifactId(null)}>Back to shelf</button>
              </div>
              <p className="chef-artifact-preview__uri" title={selectedArtifact.uri}>{selectedArtifact.uri}</p>
              {previewText(selectedArtifact) ? (
                <pre className="chef-artifact-preview__text">{previewText(selectedArtifact)}</pre>
              ) : (
                <p className="chef-artifact-preview__empty">No inline preview was provided. The artifact remains available with its provenance and metadata.</p>
              )}
              {metadataRows(selectedArtifact).length > 0 && (
                <dl className="chef-artifact-preview__metadata">
                  {metadataRows(selectedArtifact).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}
                </dl>
              )}
              {canDownload(selectedArtifact) && (
                <a className="chef-artifact-preview__download" href={`/api/artifacts/${encodeURIComponent(selectedArtifact.id)}/download`} download>Download artifact</a>
              )}
            </section>
          )}
          {!selectedArtifact && <>
            <div className="chef-artifact-shelf__list">
              {shelfArtifacts.map((artifact) => (
                <article key={`shelf:${artifact.id}:${artifact.version}`} className="chef-artifact-shelf__item">
                  <button className="chef-artifact-shelf__inspect" type="button" onClick={() => setSelectedArtifactId(artifact.id)} aria-label={`Preview ${artifact.name}`}>
                    <div className="chef-artifact-shelf__item-icon" aria-hidden="true">{artifactIcon(artifact.type)}</div>
                    <div className="chef-artifact-shelf__item-body">
                      <span>{artifactLabel(artifact.type)}</span>
                      <strong title={artifact.name}>{artifact.name}</strong>
                      <small title={provenanceLabel(artifact)}>{provenanceLabel(artifact)}</small>
                    </div>
                  </button>
                  {canDownload(artifact) ? (
                    <a href={`/api/artifacts/${encodeURIComponent(artifact.id)}/download`} download title={`Download ${artifact.name}`}>Download</a>
                  ) : (
                    <span className="chef-artifact-shelf__stored">Stored</span>
                  )}
                </article>
              ))}
            </div>
            {artifacts.length > MAX_SHELF_RESULTS && (
              <p className="chef-artifact-shelf__limit">Showing the latest {MAX_SHELF_RESULTS} of {artifacts.length} results.</p>
            )}
          </>}
        </div>
      )}
    </section>,
    target,
  );
}
