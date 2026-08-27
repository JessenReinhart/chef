import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { api } from "./api";
import {
  MAX_SHELF_RESULTS,
  MAX_VISIBLE_RESULTS,
  SPATIAL_RESULT_SLOTS,
  artifactHandoff,
  artifactsForCurrentMission,
  canDownload,
  copyRunCommand,
  metadataRows,
  previewText,
  provenanceLabel,
  recentArtifacts,
  type ArtifactType,
  type LivingArtifact,
  type RunCommandCopyResult,
} from "./artifactProjection";
import { projectMissionActivity } from "./missionActivityProjection";
import "./living-artifact.css";
import "./artifact-preview.css";

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

type MissionResultScope = { missionId: string; taskIds: string[] } | null;

export function LivingArtifactFeature() {
  const [enabled, setEnabled] = useState(() => localStorage.getItem("chef:view-mode") !== "power");
  const [artifacts, setArtifacts] = useState<LivingArtifact[]>([]);
  const [missionScope, setMissionScope] = useState<MissionResultScope | undefined>(undefined);
  const [target, setTarget] = useState<Element | null>(null);
  const [shelfOpen, setShelfOpen] = useState(false);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [runCopyState, setRunCopyState] = useState<Record<string, RunCommandCopyResult>>({});

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
      setRunCopyState({});
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
      if (response.ok) {
        const body = await response.json() as { ok?: boolean; data?: LivingArtifact[] };
        if (body.ok && Array.isArray(body.data)) setArtifacts(body.data);
      }
    } catch {
      // Artifact history can recover independently on the next poll/event.
    }

    try {
      const state = await api.stateRaw();
      const activity = projectMissionActivity({
        missions: state.missions ?? [],
        tasks: state.tasks,
        events: state.events,
      }, []);
      setMissionScope(activity ? { missionId: activity.mission.id, taskIds: activity.taskIds } : null);
    } catch {
      // Keep the previous authoritative scope rather than guessing from artifact chronology.
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

  const currentMissionArtifacts = useMemo(
    () => artifactsForCurrentMission(artifacts, missionScope),
    [artifacts, missionScope],
  );
  const visibleArtifacts = useMemo(
    () => recentArtifacts(currentMissionArtifacts, MAX_VISIBLE_RESULTS),
    [currentMissionArtifacts],
  );
  const shelfArtifacts = useMemo(
    () => recentArtifacts(artifacts, MAX_SHELF_RESULTS),
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

  const copyArtifactRunCommand = async (artifactId: string, runCommand: string) => {
    const writer = navigator.clipboard?.writeText
      ? navigator.clipboard.writeText.bind(navigator.clipboard)
      : undefined;
    const result = await copyRunCommand(runCommand, writer);
    setRunCopyState((current) => ({ ...current, [artifactId]: result }));
  };

  return createPortal(
    <section className="chef-result-cluster" aria-label="Workspace results">
      <div className="chef-result-cluster__label">
        <span>Results</span>
        <small>{currentMissionArtifacts.length}</small>
      </div>
      {visibleArtifacts.map((artifact, index) => {
        const handoff = artifactHandoff(artifact);
        const copyState = runCopyState[artifact.id];
        return (
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
                {handoff.summary && <small title={handoff.summary}>{handoff.summary}</small>}
                <small title={provenanceLabel(artifact)}>{provenanceLabel(artifact)}</small>
                {handoff.runCommand && <small title={handoff.runCommand}>Run: <code>{handoff.runCommand}</code></small>}
                {handoff.verifiedBy && <small title={handoff.verifiedBy}>Verified: {handoff.verifiedBy}</small>}
              </div>
            </button>
            <div className="chef-result-card__actions">
              {handoff.runCommand && (
                <button
                  className="chef-result-card__action chef-result-card__copy"
                  type="button"
                  onClick={() => void copyArtifactRunCommand(artifact.id, handoff.runCommand!)}
                  title={copyState === "copied" ? "Run command copied" : copyState === "failed" ? "Clipboard write failed" : copyState === "unavailable" ? "Clipboard unavailable" : "Copy run command"}
                  aria-label={copyState === "copied" ? `Copied run command for ${artifact.name}` : `Copy run command for ${artifact.name}`}
                >
                  {copyState === "copied" ? "✓" : copyState === "failed" || copyState === "unavailable" ? "!" : "⧉"}
                </button>
              )}
              {canDownload(artifact) ? (
                <a
                  className="chef-result-card__action"
                  href={`/api/artifacts/${encodeURIComponent(artifact.id)}/download`}
                  download
                  title={`Download ${artifact.name}`}
                >
                  ↓
                </a>
              ) : !handoff.runCommand ? (
                <span className="chef-result-card__ready" title="Stored in Chef">✓</span>
              ) : null}
            </div>
          </article>
        );
      })}

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