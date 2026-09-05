import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { loadSelectedThreadId, SELECTED_THREAD_EVENT } from "./threadApi";
import { artifactHandoff, canRevealArtifact, isFileUriArtifact } from "./artifactHandoff";
import { missionResultHandoffProjection, shouldRetainMissionResultOnRefreshFailure } from "./artifactProjection";
import { watchArtifactDownloadability } from "./artifactDownloadCapability";
import {
  artifactActionStateKey,
  artifactRevealLabel,
  copyRunCommand,
  createSingleFlightArtifactDownloader,
  createSingleFlightArtifactRevealer,
} from "./resultActions";
import { selectLivingWorkspaceMission } from "./missionActivityProjection";
import { createMissionProgressRefreshQueue, subscribeMissionProgressRefresh } from "./missionProgressStream";
import { missionTaskIdsFromEvents } from "./threadScope";
import type { UiMission, UiRuntimeEvent } from "./types";

type HomeArtifact = {
  id: string;
  type: "file" | "document" | "code" | "image" | "research" | "result";
  name: string;
  uri: string;
  version: number;
  taskId?: string;
  metadata: Record<string, unknown>;
};

type StateSnapshot = { missions?: UiMission[]; events?: UiRuntimeEvent[] };
type RunCopyState = "copied" | "error";
type RevealState = { status: "opening" | "opened" | "error"; message?: string };
type DownloadState = { status: "saving" | "saved" | "error"; message?: string };

const MAX_HOME_ARTIFACTS = 4;

export function HomeMissionArtifacts() {
  const [target, setTarget] = useState<Element | null>(null);
  const [mission, setMission] = useState<UiMission | null>(null);
  const [artifacts, setArtifacts] = useState<HomeArtifact[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [runCopyState, setRunCopyState] = useState<Record<string, RunCopyState>>({});
  const [revealState, setRevealState] = useState<Record<string, RevealState>>({});
  const [downloadState, setDownloadState] = useState<Record<string, DownloadState>>({});
  const [downloadCapability, setDownloadCapability] = useState<Record<string, boolean>>({});
  const refreshSequence = useRef(0);
  const loadedThreadId = useRef<string | null>(null);
  const revealArtifactOnce = useRef(createSingleFlightArtifactRevealer()).current;
  const downloadArtifactOnce = useRef(createSingleFlightArtifactDownloader()).current;

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    setTarget(document.querySelector("main"));
    const selectedThreadId = loadSelectedThreadId();
    if (!selectedThreadId) {
      loadedThreadId.current = null;
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

      const currentMission = selectLivingWorkspaceMission(
        (state.missions ?? []).filter((candidate) => candidate.metadata?.threadId === selectedThreadId),
      );
      const scopedMission = currentMission
        ? {
            ...currentMission,
            taskIds: [...missionTaskIdsFromEvents(state.events ?? [], [currentMission.id], currentMission.taskIds)],
          }
        : null;

      loadedThreadId.current = selectedThreadId;
      setMission(scopedMission);
      setArtifacts(artifactBody.ok && Array.isArray(artifactBody.data) ? artifactBody.data : []);
      setError(null);
    } catch (cause) {
      if (sequence !== refreshSequence.current || loadSelectedThreadId() !== selectedThreadId) return;
      if (!shouldRetainMissionResultOnRefreshFailure(loadedThreadId.current, selectedThreadId)) {
        setMission(null);
        setArtifacts([]);
      }
      setError(cause instanceof Error ? cause.message : "Mission outputs are temporarily unavailable");
    }
  }, []);

  useEffect(() => {
    const refreshQueue = createMissionProgressRefreshQueue(refresh);
    refreshQueue.trigger();
    const timer = window.setInterval(refreshQueue.trigger, 1800);
    const unsubscribe = subscribeMissionProgressRefresh(refreshQueue.trigger);
    const onThreadChanged = () => refreshQueue.trigger();
    window.addEventListener(SELECTED_THREAD_EVENT, onThreadChanged);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(SELECTED_THREAD_EVENT, onThreadChanged);
      unsubscribe();
      refreshQueue.close();
    };
  }, [refresh]);

  const resultHandoff = useMemo(() => {
    if (!mission) return { artifacts: [] as HomeArtifact[], notice: null as string | null };
    const selectedThreadId = loadSelectedThreadId();
    const missionThreadId = typeof mission.metadata?.threadId === "string" ? mission.metadata.threadId : undefined;
    return missionResultHandoffProjection(
      artifacts,
      { missionId: mission.id, taskIds: mission.taskIds, threadId: missionThreadId },
      selectedThreadId,
      mission.status,
      MAX_HOME_ARTIFACTS,
    );
  }, [artifacts, mission]);
  const missionArtifacts = resultHandoff.artifacts;
  const missingResultNotice = resultHandoff.notice;

  useEffect(() => {
    const stopWatching: Array<() => void> = [];
    for (const artifact of missionArtifacts) {
      if (!isFileUriArtifact(artifact)) continue;
      const actionKey = artifactActionStateKey(artifact.id, artifact.version);
      stopWatching.push(watchArtifactDownloadability(artifact.id, artifact.version, (downloadable) => {
        setDownloadCapability((current) => current[actionKey] === downloadable
          ? current
          : { ...current, [actionKey]: downloadable });
      }));
    }
    return () => {
      for (const stop of stopWatching) stop();
    };
  }, [missionArtifacts]);

  const handleCopyRunCommand = useCallback(async (actionKey: string, runCommand: string) => {
    const result = await copyRunCommand(runCommand, navigator.clipboard);
    setRunCopyState((current) => ({ ...current, [actionKey]: result.ok ? "copied" : "error" }));
  }, []);

  const handleRevealArtifact = useCallback(async (artifactId: string, actionKey: string) => {
    setRevealState((current) => ({ ...current, [actionKey]: { status: "opening" } }));
    const result = await revealArtifactOnce(artifactId, actionKey);
    setRevealState((current) => ({
      ...current,
      [actionKey]: result.ok
        ? { status: "opened" }
        : { status: "error", message: result.error },
    }));
  }, [revealArtifactOnce]);

  const handleDownloadArtifact = useCallback(async (artifactId: string, actionKey: string) => {
    setDownloadState((current) => ({ ...current, [actionKey]: { status: "saving" } }));
    const result = await downloadArtifactOnce(artifactId, actionKey);
    if (!result.ok) {
      setDownloadState((current) => ({ ...current, [actionKey]: { status: "error", message: result.error } }));
      return;
    }

    const url = URL.createObjectURL(result.blob);
    try {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.fileName;
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setDownloadState((current) => ({ ...current, [actionKey]: { status: "saved" } }));
    } finally {
      URL.revokeObjectURL(url);
    }
  }, [downloadArtifactOnce]);

  if (!target || (!error && missionArtifacts.length === 0 && !missingResultNotice)) return null;

  return createPortal(
    <section className="mt-4 rounded-2xl border border-white/[0.08] bg-white/[0.025] p-5" aria-label="Current Mission artifacts">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-600">Files & results</div>
          <p className="mt-1 text-xs text-zinc-500">Durable outputs from the current Mission.</p>
        </div>
        {missionArtifacts.length > 0 && <span className="text-[10px] text-zinc-600">{missionArtifacts.length} recent</span>}
      </div>

      {error && (
        <p role="status" className="mt-3 rounded-xl border border-amber-500/20 bg-amber-500/5 px-3 py-2.5 text-xs leading-5 text-amber-200">
          {error}{missionArtifacts.length > 0 ? " Showing the last known Mission result while Chef retries." : ""}
        </p>
      )}
      {missingResultNotice && (
        <p role="status" className="mt-3 rounded-xl border border-amber-500/20 bg-amber-500/5 px-3 py-2.5 text-xs leading-5 text-amber-200">
          {missingResultNotice}
        </p>
      )}
      {missionArtifacts.length > 0 && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {missionArtifacts.map((artifact) => {
            const handoff = artifactHandoff(artifact);
            const actionKey = artifactActionStateKey(artifact.id, artifact.version);
            const copyState = runCopyState[actionKey];
            const reveal = revealState[actionKey];
            const download = downloadState[actionKey];
            const revealable = canRevealArtifact(artifact);
            const downloadable = downloadCapability[actionKey] === true;
            return (
              <article key={actionKey} className="rounded-xl border border-white/[0.07] bg-black/20 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium text-zinc-200" title={artifact.name}>{artifact.name}</div>
                    <div className="mt-1 text-[10px] capitalize text-zinc-600">{artifact.type}</div>
                  </div>
                  {revealable && (
                    <div className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => void handleRevealArtifact(artifact.id, actionKey)}
                        disabled={reveal?.status === "opening"}
                        className="rounded-lg border border-white/10 px-2.5 py-1 text-[10px] font-medium text-zinc-400 transition hover:border-white/20 hover:text-zinc-100 disabled:cursor-wait disabled:opacity-60"
                      >
                        {artifactRevealLabel(reveal?.status ?? "idle")}
                      </button>
                      {downloadable && (
                        <button
                          type="button"
                          onClick={() => void handleDownloadArtifact(artifact.id, actionKey)}
                          disabled={download?.status === "saving"}
                          className="rounded-lg border border-white/10 px-2.5 py-1 text-[10px] font-medium text-zinc-400 transition hover:border-white/20 hover:text-zinc-100 disabled:cursor-wait disabled:opacity-60"
                        >
                          {download?.status === "saving" ? "Saving…" : download?.status === "saved" ? "Saved" : "Save copy"}
                        </button>
                      )}
                    </div>
                  )}
                </div>
                {reveal?.status === "error" && (
                  <p role="status" className="mt-2 text-[10px] leading-4 text-amber-300">
                    {reveal.message ?? "Could not show this result."}
                  </p>
                )}
                {download?.status === "error" && (
                  <p role="status" className="mt-2 text-[10px] leading-4 text-amber-300">
                    {download.message ?? "Could not save this result."}
                  </p>
                )}
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
                            onClick={() => void handleCopyRunCommand(actionKey, handoff.runCommand!)}
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
