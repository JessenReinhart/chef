import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ContextScopeFeature } from "./ContextScopeFeature";
import { CanvasNodeDeleteFeature } from "./CanvasNodeDeleteFeature";
import { LivingWorkspaceFeature } from "./LivingWorkspaceFeature";
import { LivingArtifactFeature } from "./LivingArtifactFeature";
import { SetupChrome } from "./SetupChrome";
import { DecisionLibraryFeature } from "./DecisionLibraryFeature";
import { ChannelRoomsFeature } from "./ChannelRoomsFeature";
import "./index.css";
import "./visual-audit.css";

function ChefRoot() {
  const [viewMode, setViewMode] = useState(() => localStorage.getItem("chef:view-mode") === "power" ? "power" : "simple");

  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = localStorage.getItem("chef:view-mode") === "power" ? "power" : "simple";
      setViewMode((current) => current === next ? current : next);
    }, 200);
    return () => window.clearInterval(timer);
  }, []);

  return <><App key={viewMode} /><ContextScopeFeature /><CanvasNodeDeleteFeature /><SetupChrome /><DecisionLibraryFeature /><LivingWorkspaceFeature /><LivingArtifactFeature /><ChannelRoomsFeature /></>;
}

const root = document.getElementById("root");
if (!root) throw new Error("root element missing");
createRoot(root).render(<ChefRoot />);
