export { artifactHandoff, type ArtifactHandoff } from "./artifactHandoff.ts";

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
  return ["run", "runCommand", "command"].some((key) => {
    const value = artifact.metadata[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}

function keepRunnableHandoffVisible<T extends MissionLinkedArtifact>(
  missionArtifacts: T[],
  visibleArtifacts: T[],
  limit: number,
): T[] {
  if (limit <= 0 || visibleArtifacts.some(hasRunInstruction)) return visibleArtifacts;

  const runnableHandoff = [...missionArtifacts].reverse().find(hasRunInstruction);
  if (!runnableHandoff) return visibleArtifacts;
  if (visibleArtifacts.length < limit) return [...visibleArtifacts, runnableHandoff];

  return [...visibleArtifacts.slice(0, Math.max(0, limit - 1)), runnableHandoff];
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
  return keepRunnableHandoffVisible(missionArtifacts, recent, limit);
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

export function shouldRetainMissionResultOnRefreshFailure(
  loadedThreadId: string | null | undefined,
  selectedThreadId: string | null | undefined,
): boolean {
  return Boolean(loadedThreadId && selectedThreadId && loadedThreadId === selectedThreadId);
}

export function shouldOfferArtifactShelf(
  workspaceArtifactCount: number,
  visibleResultCount: number,
): boolean {
  return workspaceArtifactCount > visibleResultCount;
}

export function missingResultHandoffNotice(missionStatus: string | undefined, resultCount: number): string | null {
  if (!missionStatus) return null;
  if (missionStatus === "completed" && resultCount === 0) {
    return "Work is marked complete, but Chef did not publish a durable result for this Mission.";
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
): MissionResultHandoffProjection<T> {
  if (!scope || !selectedThreadId || scope.threadId !== selectedThreadId) {
    return { artifacts: [], notice: null };
  }
  const visibleArtifacts = visibleArtifactsForCurrentMission(artifacts, scope, limit);
  return {
    artifacts: visibleArtifacts,
    notice: missingResultHandoffNotice(missionStatus, visibleArtifacts.length),
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
    .flatMap(([key, value]) => {
      if (value === null || value === undefined) return [];
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return [[key, String(value)] as [string, string]];
      }
      return [];
    })
    .slice(0, MAX_METADATA_ROWS);
}
