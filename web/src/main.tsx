import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ContextScopeFeature } from "./ContextScopeFeature";
import { SetupChrome } from "./SetupChrome";
import "./index.css";
import "./visual-audit.css";

const root = document.getElementById("root");
if (!root) throw new Error("root element missing");
createRoot(root).render(<><App /><ContextScopeFeature /><SetupChrome /></>);
