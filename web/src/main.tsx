import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ContextScopeFeature } from "./ContextScopeFeature";
import { CanvasNodeDeleteFeature } from "./CanvasNodeDeleteFeature";
import { SetupChrome } from "./SetupChrome";
import { DecisionLibraryFeature } from "./DecisionLibraryFeature";
import "./index.css";
import "./visual-audit.css";

const root = document.getElementById("root");
if (!root) throw new Error("root element missing");
createRoot(root).render(<><App /><ContextScopeFeature /><CanvasNodeDeleteFeature /><SetupChrome /><DecisionLibraryFeature /></>);
