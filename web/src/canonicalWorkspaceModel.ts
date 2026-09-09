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

/** Report whether the requested depth was durably persisted without throwing into the UI session. */
export function persistWorkspaceDepth(depth: WorkspaceDepth): boolean {
  try {
    globalThis.localStorage?.setItem(WORKSPACE_DEPTH_STORAGE_KEY, depth);
    return true;
  } catch {
    return false;
  }
}

export function nextWorkspaceDepth(depth: WorkspaceDepth): WorkspaceDepth {
  return depth === "power" ? "simple" : "power";
}

/**
 * Runtime details mount code that still expects browser storage to exist.
 * If persistence is denied, keep the canonical workspace in Simple Mode rather
 * than navigating into a surface that cannot safely initialize in that browser.
 */
export function requestedWorkspaceDepth(depth: WorkspaceDepth): WorkspaceDepth {
  const next = nextWorkspaceDepth(depth);
  const persisted = persistWorkspaceDepth(next);
  if (next === "simple") return "simple";
  return persisted ? "power" : "simple";
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
