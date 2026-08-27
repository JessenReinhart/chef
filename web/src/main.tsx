import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ContextScopeFeature } from "./ContextScopeFeature";
import { CanvasNodeDeleteFeature } from "./CanvasNodeDeleteFeature";
import { LivingWorkspaceFeature } from "./LivingWorkspaceFeature";
import { LivingArtifactFeature } from "./LivingArtifactFeature";
import { MissionArtifactsFeature } from "./MissionArtifactsFeature";
import { SetupChrome } from "./SetupChrome";
import { DecisionLibraryFeature } from "./DecisionLibraryFeature";
import { ChannelRoomsFeature } from "./ChannelRoomsFeature";
import { AgentContextInspector } from "./AgentContextInspector";
import { WorkspaceContextBar } from "./WorkspaceContextBar";
import { MissionActivityRail } from "./MissionActivityRail";
import {
  nextWorkspaceDepth,
  readWorkspaceDepth,
  workspaceSurfacePlan,
  type WorkspaceDepth,
} from "./canonicalWorkspaceModel";
import "./index.css";
import "./visual-audit.css";
import "./advanced-workspace.css";
import "./workbench-depth.css";
import "./canonical-workspace.css";

function persistedDepth(): WorkspaceDepth {
  return readWorkspaceDepth(localStorage.getItem("chef:view-mode"));
}

function ChefRoot() {
  const [viewMode, setViewMode] = useState<WorkspaceDepth>(persistedDepth);

  // The Living Workspace still exposes its own Advanced action. Keep both
  // controls on the same persisted depth without mounting both streaming trees.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const persisted = persistedDepth();
      setViewMode((current) => current === persisted ? current : persisted);
    }, 200);
    return () => window.clearInterval(timer);
  }, []);

  const toggleRuntimeDetails = () => {
    const next = nextWorkspaceDepth(viewMode);
    localStorage.setItem("chef:view-mode", next);
    setViewMode(next);
  };

  const plan = workspaceSurfacePlan(viewMode);
  const runtimeDetailsVisible = viewMode === "power";

  return <>
    <div className="workbench-depth-controls chef-canonical-depth" aria-label="Workspace depth">
      <button
        type="button"
        onClick={toggleRuntimeDetails}
        className="workbench-depth-controls__runtime"
        aria-pressed={runtimeDetailsVisible}
        title="Reveal runtime and debugging detail only when you need it"
      >
        <span>Runtime details</span>
        <span className="workbench-depth-controls__state" aria-hidden="true">
          {runtimeDetailsVisible ? "Shown" : "Hidden"}
        </span>
      </button>
    </div>

    {plan.runtimeApp && <App key={viewMode} />}
    {plan.contextScopes && <ContextScopeFeature />}
    {plan.canvasDeletion && <CanvasNodeDeleteFeature />}
    {plan.decisions && <DecisionLibraryFeature />}
    {plan.missionArtifacts && <MissionArtifactsFeature />}
    {plan.rooms && <ChannelRoomsFeature />}
    {plan.agentContext && <AgentContextInspector />}

    {plan.projectContext && <WorkspaceContextBar />}
    {plan.livingWorkspace && <LivingWorkspaceFeature />}
    {plan.missionActivity && <MissionActivityRail />}
    {plan.livingArtifacts && <LivingArtifactFeature />}

    <SetupChrome surface="workbench" />
  </>;
}

const root = document.getElementById("root");
if (!root) throw new Error("root element missing");
createRoot(root).render(<ChefRoot />);
