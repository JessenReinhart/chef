import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { UiMission } from "./types";

type MissionArtifact = {
  id: string;
  type: "file" | "document" | "code" | "image" | "research" | "result";
  name: string;
  uri: string;
  version: number;
  createdBy: string;
  taskId?: string;
  metadata: Record<string, unknown>;
};

type StateSnapshot = {
  missions?: UiMission[];
};

const MAX_MISSION_ARTIFACTS = 6;

function artifactSummary(artifact: MissionArtifact): string | null {
  const value = artifact.metadata.summary ?? artifact.metadata.preview ?? artifact.metadata.description;
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const text = value.trim();
  return text.length > 180 ? `${text.slice(0, 180)}…` : text;
}

function canDownload(artifact: MissionArtifact): boolean {
  return artifact.uri.startsWith("file:");
}

export function MissionArtifactsFeature() {
  const [target, setTarget] = useState<Element | null>(null);
  const [mission, setMission] = useState<UiMission | null>(null);
  const [artifacts, setArtifacts] = useState<MissionArtifact[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const nextTarget = document.querySelector('[aria-label="Mission overview"] > div');
    setTarget(nextTarget);
    if (!nextTarget) return;

    try {
      const [stateResponse, artifactsResponse] = await Promise.all([
        fetch("/api/state"),
        fetch("/api/artifacts"),
      ]);
      if (!stateResponse.ok || !artifactsResponse.ok) {
        throw new Error("Mission work products are temporarily unavailable");
      }

      const state = await stateResponse.json() as StateSnapshot;
      const artifactBody = await artifactsResponse.json() as { ok?: boolean; data?: MissionArtifact[] };
      const latestMission = [...(state.missions ?? [])].sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
      setMission(latestMission);
      setArtifacts(artifactBody.ok && Array.isArray(artifactBody.data) ? artifactBody.data : []);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Mission work products are temporarily unavailable");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const stream = new EventSource("/api/events?types=artifact.*");
    stream.onmessage = () => void refresh();
    return () => stream.close();
  }, [refresh]);

  const missionArtifacts = useMemo(() => {
    if (!mission) return [];
    const taskIds = new Set(mission.taskIds);
    return artifacts
      .filter((artifact) => artifact.taskId && taskIds.has(artifact.taskId))
      .slice(-MAX_MISSION_ARTIFACTS)
      .reverse();
  }, [artifacts, mission]);

  if (!target || !mission) return null;

  return createPortal(
    <section className="xl:col-span-2 rounded-xl border border-[#30363d] bg-[#010409]/55 p-3" aria-label="Mission artifacts">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8b949e]">Mission artifacts</h3>
          <p className="mt-0.5 text-[10px] text-[#6e7681]">Durable outputs produced by tasks in this Mission.</p>
        </div>
        <span className="text-[10px] text-[#484f58]">{missionArtifacts.length}{artifacts.length > missionArtifacts.length ? ` shown` : ""}</span>
      </div>

      {error ? (
        <p className="text-[10px] text-amber-300">{error}</p>
      ) : missionArtifacts.length === 0 ? (
        <p className="text-[10px] text-[#6e7681]">No durable artifacts have been produced by this Mission yet.</p>
      ) : (
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {missionArtifacts.map((artifact) => (
            <article key={`${artifact.id}:${artifact.version}`} className="rounded-lg border border-[#21262d] bg-[#0d1117] p-2.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-[11px] font-medium text-[#e6edf3]" title={artifact.name}>{artifact.name}</div>
                  <div className="mt-0.5 truncate text-[9px] text-[#6e7681]" title={`${artifact.type} · v${artifact.version} · ${artifact.createdBy}`}>
                    {artifact.type} · v{artifact.version} · {artifact.createdBy}
                  </div>
                </div>
                {canDownload(artifact) && (
                  <a
                    className="shrink-0 rounded border border-[#30363d] px-2 py-1 text-[9px] text-[#c9d1d9] hover:border-cyan-500/40"
                    href={`/api/artifacts/${encodeURIComponent(artifact.id)}/download`}
                    download
                  >
                    Download
                  </a>
                )}
              </div>
              {artifactSummary(artifact) && <p className="mt-2 text-[10px] leading-4 text-[#8b949e]">{artifactSummary(artifact)}</p>}
              <div className="mt-2 text-[9px] text-[#484f58]">task:{artifact.taskId?.slice(0, 8)}</div>
            </article>
          ))}
        </div>
      )}
    </section>,
    target,
  );
}
