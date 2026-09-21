import { artifactHandoff, canRevealArtifact, type ArtifactHandoff } from "./artifactHandoff.ts";

export { artifactHandoff, type ArtifactHandoff };

export type ArtifactType = "file" | "document" | "code" | "image" | "research" | "result";

export type LivingArtifact = {
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

export type MissionArtifactScope = {
  missionId: string;
  taskIds: Iterable<string>;
  threadId?: string;
};

type MissionLinkedArtifact = {
  taskId?: string;
  uri?: unknown;
  metadata: Record<string, unknown>;
};

export type MissionResultHandoffProjection<T> = {
  artifacts: T[];
  notice: string | null;
};

export type RunCommandCopyResult = "copied" | "unavailable" | "failed";

export const MAX_VISIBLE_RESULTS = 4;
export const MAX_SHELF_RESULTS = 24;
export const SPATIAL_RESULT_SLOTS = ["near", "upper", "outer", "lower"] as const;
const MAX_PREVIEW_LENGTH = 800;
const MAX_METADATA_ROWS = 8;

export function recentArtifacts<T>(artifacts: T[], limit: number): T[] {
  return artifacts.slice(-limit).reverse();
}

function hasRunInstruction(artifact: MissionLinkedArtifact): boolean {
  return artifactHandoff({ uri: "", metadata: artifact.metadata }).runCommand !== null;
}

function hasPublishedResultLocation(artifact: MissionLinkedArtifact): boolean {
  const uri = typeof artifact.uri === "string" ? artifact.uri : "";
  return canRevealArtifact({ uri, metadata: artifact.metadata });
}

function keepActionableHandoffsVisible<T extends MissionLinkedArtifact>(
  missionArtifacts: T[],
  visibleArtifacts: T[],
  limit: number,
): T[] {
  if (limit <= 0) return [];

  const requiredArtifacts: T[] = [];
  const runnableHandoff = [...missionArtifacts].reverse().find(hasRunInstruction);
  if (runnableHandoff) requiredArtifacts.push(runnableHandoff);

  const locatedHandoff = [...missionArtifacts].reverse().find(hasPublishedResultLocation);
  if (locatedHandoff && !requiredArtifacts.includes(locatedHandoff)) requiredArtifacts.push(locatedHandoff);

  // Start from the recent projection, then reserve one slot for each distinct
  // actionable handoff. This makes the retention contract explicit and avoids
  // relying on replacement order when multiple required artifacts are outside
  // the visible window.
  const next: T[] = [];
  for (const artifact of visibleArtifacts) {
    if (!next.includes(artifact)) next.push(artifact);
  }
  for (const requiredArtifact of requiredArtifacts) {
    if (next.includes(requiredArtifact)) continue;
    const replaceIndex = next.findIndex((artifact) => !requiredArtifacts.includes(artifact));
    if (next.length < limit) {
      next.push(requiredArtifact);
    } else if (replaceIndex >= 0) {
      next.splice(replaceIndex, 1, requiredArtifact);
    }
  }
  return next.slice(0, limit);
}

export function artifactsForMission<T extends MissionLinkedArtifact>(
  artifacts: T[],
  missionId: string,
  taskIds: Iterable<string>,
): T[] {
  const ownedTaskIds = new Set(taskIds);
  return artifacts.filter((artifact) => {
    if (artifact.taskId && ownedTaskIds.has(artifact.taskId)) return true;
    return artifact.metadata.missionId === missionId;
  });
}

export function artifactsForCurrentMission<T extends MissionLinkedArtifact>(
  artifacts: T[],
  scope: MissionArtifactScope | null | undefined,
): T[] {
  if (!scope) return [];
  return artifactsForMission(artifacts, scope.missionId, scope.taskIds);
}

export function visibleArtifactsForCurrentMission<T extends MissionLinkedArtifact>(
  artifacts: T[],
  scope: MissionArtifactScope | null | undefined,
  limit = MAX_VISIBLE_RESULTS,
): T[] {
  const missionArtifacts = artifactsForCurrentMission(artifacts, scope);
  const recent = recentArtifacts(missionArtifacts, limit);
  return keepActionableHandoffsVisible(missionArtifacts, recent, limit);
}

export function visibleArtifactsForSelectedThreadMission<T extends MissionLinkedArtifact>(
  artifacts: T[],
  scope: MissionArtifactScope | null | undefined,
  selectedThreadId: string | null | undefined,
  limit = MAX_VISIBLE_RESULTS,
): T[] {
  if (!scope || !selectedThreadId || scope.threadId !== selectedThreadId) return [];
  return visibleArtifactsForCurrentMission(artifacts, scope, limit);
}

/**
 * Thread selection is synchronous product state. A result owned by a previously
 * loaded Thread must disappear before asynchronous replacement snapshots settle,
 * otherwise its ordinary actions can be invoked under the wrong conversation.
 */
export function shouldClearMissionResultForThreadChange(
  loadedThreadId: string | null | undefined,
  selectedThreadId: string | null | undefined,
): boolean {
  return Boolean(loadedThreadId && loadedThreadId !== selectedThreadId);
}

export function shouldRetainMissionResultOnRefreshFailure(
  loadedThreadId: string | null | undefined,
  selectedThreadId: string | null | undefined,
): boolean {
  return Boolean(loadedThreadId && selectedThreadId && loadedThreadId === selectedThreadId);
}

export function shouldRetainMissionArtifactsOnRefreshFailure(
  loadedThreadId: string | null | undefined,
  selectedThreadId: string | null | undefined,
  loadedMissionId: string | null | undefined,
  currentMissionId: string | null | undefined,
): boolean {
  return shouldRetainMissionResultOnRefreshFailure(loadedThreadId, selectedThreadId)
    && Boolean(loadedMissionId && currentMissionId && loadedMissionId === currentMissionId);
}

export function shouldOfferArtifactShelf(
  workspaceArtifactCount: number,
  visibleResultCount: number,
): boolean {
  return workspaceArtifactCount > visibleResultCount;
}

export function missingResultHandoffNotice(
  missionStatus: string | undefined,
  resultCount: number,
  resultSnapshotAvailable = true,
  resultWithLocationCount = resultCount,
): string | null {
  if (!missionStatus) return null;
  if (!resultSnapshotAvailable && missionStatus === "completed") return null;
  if (!resultSnapshotAvailable && resultCount === 0) return null;
  if (missionStatus === "completed" && resultCount === 0) {
    return "Work is marked complete, but Chef did not publish a durable result for this Mission.";
  }
  if (missionStatus === "completed" && resultWithLocationCount === 0) {
    return "Work is marked complete, but Chef did not publish a durable result location for this Mission.";
  }
  if (missionStatus === "failed" || missionStatus === "blocked" || missionStatus === "waiting_for_approval") {
    return resultCount > 0
      ? "Chef saved a partial result, but this Mission still needs attention before the handoff is complete."
      : "No durable result is available because this Mission needs attention.";
  }
  if (missionStatus === "paused") {
    return resultCount > 0
      ? "Chef saved a partial result, but this Mission is paused before the handoff is complete."
      : "No durable result is available because this Mission is paused.";
  }
  if (missionStatus === "cancelled") {
    return resultCount > 0
      ? "Chef saved a partial result, but this Mission was stopped before the handoff was complete."
      : "No durable result is available because this Mission was stopped.";
  }
  return null;
}

export function missionResultHandoffProjection<T extends MissionLinkedArtifact>(
  artifacts: T[],
  scope: MissionArtifactScope | null | undefined,
  selectedThreadId: string | null | undefined,
  missionStatus: string | undefined,
  limit = MAX_VISIBLE_RESULTS,
  resultSnapshotAvailable = true,
): MissionResultHandoffProjection<T> {
  if (!scope || !selectedThreadId || scope.threadId !== selectedThreadId) {
    return { artifacts: [], notice: null };
  }
  const missionArtifacts = artifactsForCurrentMission(artifacts, scope);
  const visibleArtifacts = keepActionableHandoffsVisible(
    missionArtifacts,
    recentArtifacts(missionArtifacts, limit),
    limit,
  );
  const locatedResultCount = missionArtifacts.filter(hasPublishedResultLocation).length;
  return {
    artifacts: visibleArtifacts,
    notice: missingResultHandoffNotice(
      missionStatus,
      missionArtifacts.length,
      resultSnapshotAvailable,
      locatedResultCount,
    ),
  };
}

export function canDownload(artifact: LivingArtifact): boolean {
  return artifact.uri.startsWith("file:");
}

export function provenanceLabel(artifact: LivingArtifact): string {
  const task = artifact.taskId ? ` · task ${artifact.taskId.slice(0, 8)}` : "";
  return `v${artifact.version} · by ${artifact.createdBy}${task}`;
}

export async function copyRunCommand(
  runCommand: string,
  writeText?: (text: string) => Promise<void>,
): Promise<RunCommandCopyResult> {
  if (!writeText) return "unavailable";
  try {
    await writeText(runCommand);
    return "copied";
  } catch {
    return "failed";
  }
}

export function previewText(artifact: LivingArtifact): string | null {
  const candidate = artifact.metadata.preview
    ?? artifact.metadata.summary
    ?? artifact.metadata.description
    ?? artifact.metadata.content;
  if (typeof candidate !== "string" || candidate.trim().length === 0) return null;
  const text = candidate.trim();
  return text.length > MAX_PREVIEW_LENGTH ? `${text.slice(0, MAX_PREVIEW_LENGTH)}…` : text;
}

export function metadataRows(artifact: LivingArtifact): Array<[string, string]> {
  return Object.entries(artifact.metadata)
    .filter(([key]) => !["preview", "summary", "description", "content"].includes(key))
    .slice(0, MAX_METADATA_ROWS)
    .map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]);
}
