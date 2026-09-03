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

export function readWorkspaceDepth(value: string | null): WorkspaceDepth {
  return value === "power" ? "power" : "simple";
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
