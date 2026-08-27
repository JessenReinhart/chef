import { useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ContextScopeFeature } from "./ContextScopeFeature";
import { CanvasNodeDeleteFeature } from "./CanvasNodeDeleteFeature";
import { LivingWorkspaceFeature } from "./LivingWorkspaceFeature";
import { LivingArtifactFeature } from "./LivingArtifactFeature";
import { MissionArtifactsFeature } from "./MissionArtifactsFeature";
import { HomeMissionArtifacts } from "./HomeMissionArtifacts";
import { HomePriorMissionResults } from "./HomePriorMissionResults";
import { SetupChrome } from "./SetupChrome";
import { DecisionLibraryFeature } from "./DecisionLibraryFeature";
import { ChannelRoomsFeature } from "./ChannelRoomsFeature";
import { AgentContextInspector } from "./AgentContextInspector";
import { IntentHome } from "./IntentHome";
import { IntentOnboarding } from "./IntentOnboarding";
import "./index.css";
import "./visual-audit.css";
import "./advanced-workspace.css";
import "./workbench-depth.css";

type ProductSurface = "home" | "workbench";

type WorkbenchDepth = "simple" | "power";

function ChefRoot() {
  const [surface, setSurface] = useState<ProductSurface>(() => localStorage.getItem("chef:surface") === "workbench" ? "workbench" : "home");
  const [viewMode, setViewMode] = useState<WorkbenchDepth>(() => localStorage.getItem("chef:view-mode") === "power" ? "power" : "simple");

  const openWorkbench = () => {
    localStorage.setItem("chef:surface", "workbench");
    setSurface("workbench");
  };

  const openHome = () => {
    localStorage.setItem("chef:surface", "home");
    setSurface("home");
  };

  const toggleRuntimeDetails = () => {
    const next: WorkbenchDepth = viewMode === "power" ? "simple" : "power";
    localStorage.setItem("chef:view-mode", next);
    setViewMode(next);
  };

  if (surface === "home") {
    return <>
      <IntentHome onOpenWorkbench={openWorkbench} />
      <HomeMissionArtifacts />
      <HomePriorMissionResults />
      <SetupChrome surface="home" />
      <IntentOnboarding />
    </>;
  }

  const runtimeDetailsVisible = viewMode === "power";

  return <>
    <div className="workbench-depth-controls" aria-label="Workbench navigation and depth">
      <button
        type="button"
        onClick={openHome}
        className="workbench-depth-controls__home"
        aria-label="Return to Chef home"
      >
        ← Home
      </button>
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

    {/* Mount only the active depth. Hidden power-mode trees retain EventSource
        connections even when CSS hides them, which can exhaust the browser's
        HTTP/1.1 per-origin connection pool and queue simple-mode POSTs forever. */}
    {runtimeDetailsVisible ? <>
      <App key="power" />
      <ContextScopeFeature />
      <CanvasNodeDeleteFeature />
      <DecisionLibraryFeature />
      <MissionArtifactsFeature />
      <ChannelRoomsFeature />
      <AgentContextInspector />
    </> : <>
      <LivingWorkspaceFeature />
      <LivingArtifactFeature />
    </>}

    <SetupChrome surface="workbench" />
  </>;
}

const root = document.getElementById("root");
if (!root) throw new Error("root element missing");
createRoot(root).render(<ChefRoot />);
