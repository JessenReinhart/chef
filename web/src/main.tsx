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
import "./index.css";
import "./visual-audit.css";
import "./advanced-workspace.css";
import "./workbench-depth.css";
import "./canonical-workspace.css";

type WorkbenchDepth = "simple" | "power";

function readWorkbenchDepth(): WorkbenchDepth {
  return localStorage.getItem("chef:view-mode") === "power" ? "power" : "simple";
}

function ChefRoot() {
  const [viewMode, setViewMode] = useState<WorkbenchDepth>(readWorkbenchDepth);

  // LivingWorkspaceFeature still exposes its own Advanced action for backwards
  // compatibility. Keep the root synchronized with that persisted depth so the
  // same-window action actually opens runtime detail instead of hiding itself.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const persisted = readWorkbenchDepth();
      setViewMode((current) => current === persisted ? current : persisted);
    }, 200);
    return () => window.clearInterval(timer);
  }, []);

  const toggleRuntimeDetails = () => {
    const next: WorkbenchDepth = viewMode === "power" ? "simple" : "power";
    localStorage.setItem("chef:view-mode", next);
    setViewMode(next);
  };

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

    {/* Chef has one canonical product surface: the Living Workspace. Runtime
        detail is progressive disclosure, not a second homepage. Mount only the
        active depth so hidden EventSource trees cannot starve browser requests. */}
    {runtimeDetailsVisible ? <>
      <App key={viewMode} />
      <ContextScopeFeature />
      <CanvasNodeDeleteFeature />
      <DecisionLibraryFeature />
      <MissionArtifactsFeature />
      <ChannelRoomsFeature />
      <AgentContextInspector />
    </> : <>
      <WorkspaceContextBar />
      <LivingWorkspaceFeature />
      <MissionActivityRail />
      <LivingArtifactFeature />
    </>}

    <SetupChrome surface="workbench" />
  </>;
}

const root = document.getElementById("root");
if (!root) throw new Error("root element missing");
createRoot(root).render(<ChefRoot />);
