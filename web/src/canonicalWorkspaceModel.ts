export type WorkspaceDepth = "simple" | "power";

export interface WorkspaceSurfacePlan {
  projectContext: boolean;
  livingWorkspace: boolean;
  missionActivity: boolean;
  livingArtifacts: boolean;
  homeMissionArtifacts: boolean;
  runtimeApp: boolean;
  contextScopes: boolean;
  canvasDeletion: boolean;
  decisions: boolean;
  missionArtifacts: boolean;
  rooms: boolean;
  agentContext: boolean;
}

const WORKSPACE_DEPTH_STORAGE_KEY = "chef:view-mode";

export function readWorkspaceDepth(value: string | null): WorkspaceDepth {
  return value === "power" ? "power" : "simple";
}

/** Browser persistence is optional; denied storage must keep the canonical Simple Mode journey bootable. */
export function readPersistedWorkspaceDepth(): WorkspaceDepth {
  try {
    return readWorkspaceDepth(globalThis.localStorage?.getItem(WORKSPACE_DEPTH_STORAGE_KEY) ?? null);
  } catch {
    return "simple";
  }
}

/** Changing workspace depth must remain usable for the current session even when persistence is denied. */
export function persistWorkspaceDepth(depth: WorkspaceDepth): void {
  try {
    globalThis.localStorage?.setItem(WORKSPACE_DEPTH_STORAGE_KEY, depth);
  } catch {
    // Keep the in-memory UI state authoritative for this session.
  }
}

export function nextWorkspaceDepth(depth: WorkspaceDepth): WorkspaceDepth {
  return depth === "power" ? "simple" : "power";
}

export function workspaceSurfacePlan(depth: WorkspaceDepth): WorkspaceSurfacePlan {
  if (depth === "power") {
    return {
      projectContext: false,
      livingWorkspace: false,
      missionActivity: false,
      livingArtifacts: false,
      homeMissionArtifacts: false,
      runtimeApp: true,
      contextScopes: true,
      canvasDeletion: true,
      decisions: true,
      missionArtifacts: true,
      rooms: true,
      agentContext: true,
    };
  }

  return {
    projectContext: true,
    livingWorkspace: true,
    missionActivity: true,
    livingArtifacts: true,
    homeMissionArtifacts: true,
    runtimeApp: false,
    contextScopes: false,
    canvasDeletion: false,
    decisions: false,
    missionArtifacts: false,
    rooms: false,
    agentContext: false,
  };
}
