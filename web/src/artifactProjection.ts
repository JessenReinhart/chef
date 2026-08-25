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

export const MAX_VISIBLE_RESULTS = 4;
export const MAX_SHELF_RESULTS = 24;
export const SPATIAL_RESULT_SLOTS = ["near", "upper", "outer", "lower"] as const;
const MAX_PREVIEW_LENGTH = 800;
const MAX_METADATA_ROWS = 8;

export function recentArtifacts(artifacts: LivingArtifact[], limit: number): LivingArtifact[] {
  return artifacts.slice(-limit).reverse();
}

export function canDownload(artifact: LivingArtifact): boolean {
  return artifact.uri.startsWith("file:");
}

export function provenanceLabel(artifact: LivingArtifact): string {
  const task = artifact.taskId ? ` · task ${artifact.taskId.slice(0, 8)}` : "";
  return `v${artifact.version} · by ${artifact.createdBy}${task}`;
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
