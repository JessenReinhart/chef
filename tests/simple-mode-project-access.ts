import { strict as assert } from "node:assert";
import { projectSelectionSummary } from "../web/src/projectSelection.ts";
import { setupChromeFeatures } from "../web/src/setupChromeFeatures.ts";

const home = setupChromeFeatures("home");
assert.equal(home.projectSwitcher, true, "Home must expose project selection before task submission");
assert.equal(home.setupTools, false, "Home must not require expert setup controls to choose a project");

const workbench = setupChromeFeatures("workbench");
assert.equal(workbench.projectSwitcher, true, "Workbench must retain project selection");
assert.equal(workbench.setupTools, true, "Workbench must retain agent and AI setup controls");

const emptySelection = projectSelectionSummary(null);
assert.equal(emptySelection.selected, false);
assert.equal(emptySelection.label, "Open project");
assert.equal(emptySelection.status, null);
assert.equal(emptySelection.ariaLabel, "Open project");

const linuxSelection = projectSelectionSummary({ name: "todo-app", path: "/home/alice/todo-app" });
assert.equal(linuxSelection.selected, true);
assert.equal(linuxSelection.label, "todo-app");
assert.equal(linuxSelection.status, "Selected");
assert.equal(linuxSelection.ariaLabel, "Selected project: todo-app (/home/alice/todo-app)");

const windowsSelection = projectSelectionSummary({ name: "todo-app", path: "C:\\dev\\todo-app" });
assert.equal(windowsSelection.selected, true);
assert.equal(windowsSelection.label, "todo-app");
assert.equal(windowsSelection.status, "Selected");
assert.equal(windowsSelection.ariaLabel, "Selected project: todo-app (C:\\dev\\todo-app)");

console.log("simple-mode-project-access: ok — project selection is available and explicitly confirmed across local path formats");
