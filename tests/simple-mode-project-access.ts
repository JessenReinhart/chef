import { strict as assert } from "node:assert";
import {
  projectSelectionSummary,
  sameSelectedProjectPath,
  waitForSelectedProject,
} from "../web/src/projectSelection.ts";
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

assert.equal(sameSelectedProjectPath("/home/alice/todo-app/", "/home/alice/todo-app"), true);
assert.equal(sameSelectedProjectPath("C:\\Dev\\Todo-App\\", "c:/dev/todo-app"), true);
assert.equal(sameSelectedProjectPath("\\\\SERVER\\Share\\Todo-App", "//server/share/todo-app/"), true);
assert.equal(sameSelectedProjectPath("/home/alice/old-project", "/home/alice/todo-app"), false);

const observed: string[] = [];
const responses: Array<{ name: string; path: string } | Error> = [
  { name: "old-project", path: "/home/alice/old-project" },
  new Error("runtime restarting"),
  { name: "todo-app", path: "/home/alice/todo-app" },
];
const activated = await waitForSelectedProject(
  "/home/alice/todo-app",
  async () => {
    const next = responses.shift();
    if (!next) throw new Error("unexpected project poll");
    if (next instanceof Error) throw next;
    observed.push(next.path);
    return next;
  },
  async () => {},
  4,
);
assert.equal(activated.path, "/home/alice/todo-app");
assert.deepEqual(
  observed,
  ["/home/alice/old-project", "/home/alice/todo-app"],
  "a stale old-runtime response must not be accepted as successful project selection",
);

await assert.rejects(
  () => waitForSelectedProject(
    "C:\\dev\\new-project",
    async () => ({ name: "old-project", path: "C:\\dev\\old-project" }),
    async () => {},
    2,
  ),
  /selected project did not become active/,
  "selection timeout must fail visibly instead of reloading the wrong workspace",
);

console.log("simple-mode-project-access: ok — project selection waits for the requested runtime across Linux and Windows path formats");
