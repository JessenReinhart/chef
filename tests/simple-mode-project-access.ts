import { strict as assert } from "node:assert";
import {
  confirmPickedProject,
  createSingleFlightProjectSelection,
  projectSelectionSummary,
  recentProjectsExcludingSelected,
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
assert.equal(emptySelection.transitioning, false);
assert.equal(emptySelection.label, "Open project");
assert.equal(emptySelection.status, null);
assert.equal(emptySelection.ariaLabel, "Open project");

const linuxSelection = projectSelectionSummary({ name: "todo-app", path: "/home/alice/todo-app" });
assert.equal(linuxSelection.selected, true);
assert.equal(linuxSelection.transitioning, false);
assert.equal(linuxSelection.label, "todo-app");
assert.equal(linuxSelection.status, "Selected");
assert.equal(linuxSelection.ariaLabel, "Selected project: todo-app (/home/alice/todo-app)");

const windowsSelection = projectSelectionSummary({ name: "todo-app", path: "C:\\dev\\todo-app" });
assert.equal(windowsSelection.selected, true);
assert.equal(windowsSelection.transitioning, false);
assert.equal(windowsSelection.label, "todo-app");
assert.equal(windowsSelection.status, "Selected");
assert.equal(windowsSelection.ariaLabel, "Selected project: todo-app (C:\\dev\\todo-app)");

const picking = projectSelectionSummary(
  { name: "old-project", path: "/home/alice/old-project" },
  { busy: true },
);
assert.equal(picking.selected, false, "the old active runtime must not look settled while a new project is being chosen");
assert.equal(picking.transitioning, true);
assert.equal(picking.label, "Opening project");
assert.equal(picking.status, "Switching");
assert.equal(picking.ariaLabel, "Opening project");

const linuxTransition = projectSelectionSummary(
  { name: "old-project", path: "/home/alice/old-project" },
  { busy: true, pendingPath: "/home/alice/todo-app" },
);
assert.equal(linuxTransition.selected, false, "the previous Linux project must not remain labelled Selected during handoff");
assert.equal(linuxTransition.transitioning, true);
assert.equal(linuxTransition.label, "Opening todo-app");
assert.equal(linuxTransition.status, "Switching");
assert.equal(linuxTransition.ariaLabel, "Opening project: /home/alice/todo-app");

const windowsTransition = projectSelectionSummary(
  { name: "old-project", path: "C:\\dev\\old-project" },
  { busy: true, pendingPath: "C:\\Dev\\Todo-App\\" },
);
assert.equal(windowsTransition.selected, false, "the previous Windows project must not remain labelled Selected during handoff");
assert.equal(windowsTransition.transitioning, true);
assert.equal(windowsTransition.label, "Opening Todo-App");
assert.equal(windowsTransition.status, "Switching");
assert.equal(windowsTransition.ariaLabel, "Opening project: C:\\Dev\\Todo-App\\");

const dotSegmentTransition = projectSelectionSummary(
  { name: "old-project", path: "C:\\dev\\old-project" },
  { busy: true, pendingPath: "C:\\Dev\\.\\Todo-App\\." },
);
assert.equal(
  dotSegmentTransition.label,
  "Opening Todo-App",
  "a harmless current-directory segment must not degrade the visible project handoff into an 'Opening .' label",
);

assert.equal(sameSelectedProjectPath("/home/alice/todo-app/", "/home/alice/todo-app"), true);
assert.equal(sameSelectedProjectPath("C:\\Dev\\Todo-App\\", "c:/dev/todo-app"), true);
assert.equal(sameSelectedProjectPath("\\\\SERVER\\Share\\Todo-App", "//server/share/todo-app/"), true);
assert.equal(sameSelectedProjectPath("/home/alice/old-project", "/home/alice/todo-app"), false);
assert.equal(
  sameSelectedProjectPath("/home/alice/./todo-app/.", "/home/alice/todo-app"),
  true,
  "Linux project identity must ignore current-directory path segments",
);
assert.equal(
  sameSelectedProjectPath("C:\\Dev\\.\\Todo-App\\.", "c:/dev/todo-app"),
  true,
  "Windows project identity must ignore current-directory path segments while retaining case-insensitive matching",
);
assert.equal(
  sameSelectedProjectPath("\\\\SERVER\\Share\\.\\Todo-App\\.", "//server/share/todo-app"),
  true,
  "UNC project identity must ignore current-directory path segments",
);
assert.equal(
  sameSelectedProjectPath("/home/alice/work/../todo-app", "/home/alice/todo-app"),
  false,
  "project identity must not invent parent-directory normalization without filesystem context",
);

const windowsRecent = recentProjectsExcludingSelected("C:\\Dev\\Chef", [
  { name: "Chef duplicate", path: "c:/dev/chef/" },
  { name: "Todo", path: "C:\\Dev\\Todo" },
  { name: "Todo duplicate", path: "c:/dev/todo/" },
  { name: "Share", path: "\\\\SERVER\\Share\\Project" },
  { name: "Share duplicate", path: "//server/share/project/" },
  { name: "Notes", path: "D:\\Work\\Notes" },
]);
assert.deepEqual(
  windowsRecent.map((project) => project.name),
  ["Todo", "Share", "Notes"],
  "Recent must exclude the selected Windows project and keep only the first entry for each equivalent local or UNC path",
);

const linuxRecent = recentProjectsExcludingSelected("/home/alice/Chef", [
  { name: "Chef trailing slash", path: "/home/alice/Chef/" },
  { name: "chef lowercase", path: "/home/alice/chef" },
  { name: "chef lowercase duplicate", path: "/home/alice/chef/" },
  { name: "Todo", path: "/home/alice/todo" },
]);
assert.deepEqual(
  linuxRecent.map((project) => project.name),
  ["chef lowercase", "Todo"],
  "Linux Recent filtering must dedupe trailing-slash aliases while preserving case-distinct paths",
);

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
assert.deepEqual(observed, ["/home/alice/old-project", "/home/alice/todo-app"]);

const dotSegmentActivated = await waitForSelectedProject(
  "C:\\Dev\\.\\Todo-App\\.",
  async () => ({ name: "Todo-App", path: "c:/dev/todo-app" }),
  async () => {},
  1,
);
assert.equal(
  dotSegmentActivated.path,
  "c:/dev/todo-app",
  "project confirmation must settle immediately when the runtime canonicalizes harmless dot segments from the requested Windows path",
);

let cancelledLoadCalls = 0;
const cancelled = await confirmPickedProject(
  async () => ({ cancelled: true }),
  async () => {
    cancelledLoadCalls += 1;
    return { name: "unexpected", path: "/unexpected" };
  },
  async () => {},
);
assert.equal(cancelled, null);
assert.equal(cancelledLoadCalls, 0);

const handoffResponses: Array<{ name: string; path: string } | Error> = [
  new Error("runtime restarting"),
  { name: "old-project", path: "C:\\dev\\old-project" },
  { name: "Todo-App", path: "C:\\Dev\\Todo-App\\" },
];
const confirmed = await confirmPickedProject(
  async () => ({ path: "c:/dev/todo-app" }),
  async () => {
    const next = handoffResponses.shift();
    if (!next) throw new Error("unexpected project confirmation poll");
    if (next instanceof Error) throw next;
    return next;
  },
  async () => {},
  4,
);
assert.equal(confirmed?.name, "Todo-App");
assert.equal(confirmed?.path, "C:\\Dev\\Todo-App\\");

await assert.rejects(
  () => waitForSelectedProject(
    "C:\\dev\\new-project",
    async () => ({ name: "old-project", path: "C:\\dev\\old-project" }),
    async () => {},
    2,
  ),
  /selected project did not become active/,
);

const singleFlight = createSingleFlightProjectSelection();
let releaseFirst!: () => void;
const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve; });
let actionCalls = 0;
const first = singleFlight(async () => {
  actionCalls += 1;
  await firstPending;
  return "first";
});
const duplicate = await singleFlight(async () => {
  actionCalls += 1;
  return "duplicate";
});
assert.deepEqual(duplicate, { accepted: false });
assert.equal(actionCalls, 1);
releaseFirst();
assert.deepEqual(await first, { accepted: true, value: "first" });

const afterSuccess = await singleFlight(async () => {
  actionCalls += 1;
  return "after-success";
});
assert.deepEqual(afterSuccess, { accepted: true, value: "after-success" });

await assert.rejects(
  () => singleFlight(async () => {
    actionCalls += 1;
    throw new Error("selection failed");
  }),
  /selection failed/,
);
const afterFailure = await singleFlight(async () => {
  actionCalls += 1;
  return "after-failure";
});
assert.deepEqual(afterFailure, { accepted: true, value: "after-failure" });

const afterCancellation = await singleFlight(async () => {
  actionCalls += 1;
  return null;
});
assert.deepEqual(afterCancellation, { accepted: true, value: null });
const afterCancellationRetry = await singleFlight(async () => {
  actionCalls += 1;
  return "after-cancel";
});
assert.deepEqual(afterCancellationRetry, { accepted: true, value: "after-cancel" });

console.log("simple-mode-project-access: ok — project selection stays truthful through Linux/Windows handoffs, canonical dot-segment paths, Recent aliases, and serialized reopen ownership");
