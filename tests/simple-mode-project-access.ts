import { strict as assert } from "node:assert";
import { setupChromeFeatures } from "../web/src/setupChromeFeatures.ts";

const home = setupChromeFeatures("home");
assert.equal(home.projectSwitcher, true, "Home must expose project selection before task submission");
assert.equal(home.setupTools, false, "Home must not require expert setup controls to choose a project");

const workbench = setupChromeFeatures("workbench");
assert.equal(workbench.projectSwitcher, true, "Workbench must retain project selection");
assert.equal(workbench.setupTools, true, "Workbench must retain agent and AI setup controls");

console.log("simple-mode-project-access: ok — project selection is part of the normal Home journey");