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
import { IntentHome } from "./IntentHome";
import "./index.css";
import "./visual-audit.css";
import "./advanced-workspace.css";

type ProductSurface = "home" | "workbench";

function ChefRoot() {
  const [surface, setSurface] = useState<ProductSurface>(() => localStorage.getItem("chef:surface") === "workbench" ? "workbench" : "home");
  const [viewMode, setViewMode] = useState(() => localStorage.getItem("chef:view-mode") === "power" ? "power" : "simple");

  useEffect(() => {
    if (surface !== "workbench") return;
    const timer = window.setInterval(() => {
      const next = localStorage.getItem("chef:view-mode") === "power" ? "power" : "simple";
      setViewMode((current) => current === next ? current : next);
    }, 200);
    return () => window.clearInterval(timer);
  }, [surface]);

  const openWorkbench = () => {
    localStorage.setItem("chef:surface", "workbench");
    setSurface("workbench");
  };

  const openHome = () => {
    localStorage.setItem("chef:surface", "home");
    setSurface("home");
  };

  if (surface === "home") {
    return <><IntentHome onOpenWorkbench={openWorkbench} /><SetupChrome /></>;
  }

  return (
    <div className="relative h-screen w-screen overflow-hidden">
      <button
        type="button"
        onClick={openHome}
        className="fixed left-[132px] top-[9px] z-[80] rounded-md border border-white/10 bg-[#0d1117]/90 px-2.5 py-1 text-[10px] font-medium text-[#8b949e] backdrop-blur transition hover:border-white/20 hover:text-[#e6edf3]"
        aria-label="Return to Chef home"
      >
        ← Home
      </button>
      <App key={viewMode} />
      <ContextScopeFeature />
      <CanvasNodeDeleteFeature />
      <SetupChrome />
      <DecisionLibraryFeature />
      <LivingWorkspaceFeature />
      <LivingArtifactFeature />
      <MissionArtifactsFeature />
      <ChannelRoomsFeature />
      <AgentContextInspector />
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("root element missing");
createRoot(root).render(<ChefRoot />);
