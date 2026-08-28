import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { loadSelectedThreadId, SELECTED_THREAD_EVENT } from "./threadApi";
import { artifactHandoff } from "./artifactHandoff";
import { visibleArtifactsForCurrentMission } from "./artifactProjection";
import { copyRunCommand } from "./resultActions";
import type { UiMission } from "./types";

type HomeArtifact = {
  id: string;
  type: "file" | "document" | "code" | "image" | "research" | "result";
  name: string;
  uri: string;
  version: number;
  taskId?: string;
  metadata: Record<string, unknown>;
};

type StateSnapshot = { missions?: UiMission[] };
type RunCopyState = "copied" | "error";

const MAX_HOME_ARTIFACTS = 4;

export function HomeMissionArtifacts() {
  const [target, setTarget] = useState<Element | null>(null);
  const [mission, setMission] = useState<UiMission | null>(null);
  const [artifacts, setArtifacts] = useState<HomeArtifact[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [runCopyState, setRunCopyState] = useState<Record<string, RunCopyState>>({});
  const refreshSequence = useRef(0);

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    setTarget(document.querySelector("main"));
    const selectedThreadId = loadSelectedThreadId();
    if (!selectedThreadId) {
      setMission(null);
      setArtifacts([]);
      setError(null);
      return;
    }

    try {
      const [stateResponse, artifactResponse] = await Promise.all([
        fetch("/api/state"),
        fetch("/api/artifacts"),
      ]);
      if (!stateResponse.ok) throw new Error("Current work is temporarily unavailable");
      if (!artifactResponse.ok) throw new Error("Mission outputs are temporarily unavailable");

      const state = await stateResponse.json() as StateSnapshot;
      const artifactBody = await artifactResponse.json() as { ok?: boolean; data?: HomeArtifact[] };
      if (sequence !== refreshSequence.current || loadSelectedThreadId() !== selectedThreadId) return;

      const currentMission = [...(state.missions ?? [])]
        .filter((candidate) => candidate.metadata?.threadId === selectedThreadId)
        .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;

      setMission(currentMission);
      setArtifacts(artifactBody.ok && Array.isArray(artifactBody.data) ? artifactBody.data : []);
      setError(null);
    } catch (cause) {
      if (sequence !== refreshSequence.current || loadSelectedThreadId() !== selectedThreadId) return;
      setMission(null);
      setArtifacts([]);
      setError(cause instanceof Error ? cause.message : "Mission outputs are temporarily unavailable");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1800);
    const onThreadChanged = () => void refresh();
    window.addEventListener(SELECTED_THREAD_EVENT, onThreadChanged);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(SELECTED_THREAD_EVENT, onThreadChanged);
    };
  }, [refresh]);

  const missionArtifacts = useMemo(() => {
    if (!mission) return [];
    return visibleArtifactsForCurrentMission(
      artifacts,
      { missionId: mission.id, taskIds: mission.taskIds },
      MAX_HOME_ARTIFACTS,
    );
  }, [artifacts, mission]);

  const handleCopyRunCommand = useCallback(async (artifactId: string, runCommand: string) => {
    const result = await copyRunCommand(runCommand, navigator.clipboard);
    setRunCopyState((current) => ({ ...current, [artifactId]: result.ok ? "copied" : "error" }));
  }, []);

  if (!target || (!error && missionArtifacts.length === 0)) return null;

  return createPortal(
    <section className="mt-4 rounded-2xl border border-white/[0.08] bg-white/[0.025] p-5" aria-label="Current Mission artifacts">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-600">Files & results</div>
          <p className="mt-1 text-xs text-zinc-500">Durable outputs from the current Mission.</p>
        </div>
        {missionArtifacts.length > 0 && <span className="text-[10px] text-zinc-600">{missionArtifacts.length} recent</span>}
      </div>

      {error ? (
        <p className="mt-3 text-xs text-amber-300">{error}</p>
      ) : (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {missionArtifacts.map((artifact) => {
            const handoff = artifactHandoff(artifact);
            const copyState = runCopyState[artifact.id];
            return (
              <article key={`${artifact.id}:${artifact.version}`} className="rounded-xl border border-white/[0.07] bg-black/20 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium text-zinc-200" title={artifact.name}>{artifact.name}</div>
                    <div className="mt-1 text-[10px] capitalize text-zinc-600">{artifact.type}</div>
                  </div>
                  {artifact.uri.startsWith("file:") && (
                    <a
                      href={`/api/artifacts/${encodeURIComponent(artifact.id)}/download`}
                      download
                      className="shrink-0 rounded-lg border border-white/10 px-2.5 py-1 text-[10px] font-medium text-zinc-400 transition hover:border-white/20 hover:text-zinc-100"
                    >
                      Save copy
                    </a>
                  )}
                </div>
                {handoff.summary && <p className="mt-2 line-clamp-3 text-[11px] leading-4 text-zinc-500">{handoff.summary}</p>}
                {(handoff.location || handoff.runCommand || handoff.verification) && (
                  <dl className="mt-3 space-y-2 border-t border-white/[0.06] pt-3 text-[10px] leading-4">
                    {handoff.location && (
                      <div>
                        <dt className="font-medium uppercase tracking-[0.12em] text-zinc-600">Result location</dt>
                        <dd className="mt-0.5 break-all font-mono text-zinc-400" title={handoff.location}>{handoff.location}</dd>
                      </div>
                    )}
                    {handoff.runCommand && (
                      <div>
                        <div className="flex items-center justify-between gap-2">
                          <dt className="font-medium uppercase tracking-[0.12em] text-zinc-600">Run</dt>
                          <button
                            type="button"
                            onClick={() => void handleCopyRunCommand(artifact.id, handoff.runCommand!)}
                            className="rounded-md border border-white/10 px-2 py-0.5 font-medium text-zinc-400 transition hover:border-white/20 hover:text-zinc-100"
                          >
                            {copyState === "copied" ? "Copied" : "Copy run command"}
                          </button>
                        </div>
                        <dd className="mt-0.5 break-all font-mono text-zinc-300" title={handoff.runCommand}>{handoff.runCommand}</dd>
                        {copyState === "error" && (
                          <p role="status" className="mt-1 text-amber-300">Could not copy. Select the command above instead.</p>
                        )}
                      </div>
                    )}
                    {handoff.verification && (
                      <div>
                        <dt className="font-medium uppercase tracking-[0.12em] text-zinc-600">Verified</dt>
                        <dd className="mt-0.5 text-zinc-400">{handoff.verification}</dd>
                      </div>
                    )}
                  </dl>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>,
    target,
  );
}
