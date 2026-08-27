import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

const main = await readFile(new URL("../web/src/main.tsx", import.meta.url), "utf8");
const living = await readFile(new URL("../web/src/LivingWorkspaceFeature.tsx", import.meta.url), "utf8");
const projectContext = await readFile(new URL("../web/src/WorkspaceContextBar.tsx", import.meta.url), "utf8");
const activity = await readFile(new URL("../web/src/MissionActivityRail.tsx", import.meta.url), "utf8");
const northStar = await readFile(new URL("../docs/UI_NORTH_STAR_LIVING_WORKSPACE.md", import.meta.url), "utf8");

assert.doesNotMatch(main, /chef:surface/, "Chef must not persist a competing Home vs Workbench product surface");
assert.doesNotMatch(main, /<IntentHome\b/, "the dark Intent Home must not remain a second default application");
assert.match(main, /<LivingWorkspaceFeature \/>/, "the Living Workspace must be the canonical default surface");
assert.match(main, /<WorkspaceContextBar \/>/, "default Chef must make active project context visible");
assert.match(main, /<MissionActivityRail \/>/, "default Chef must expose useful live work activity");
assert.match(main, /<LivingArtifactFeature \/>/, "results and artifacts must remain in the canonical workspace");
assert.match(main, /Runtime details/, "deep runtime inspection must remain deliberately reachable");
assert.match(main, /runtimeDetailsVisible \? <>/, "runtime detail must be progressive disclosure rather than a second product");
assert.match(main, /<App key=\{viewMode\} \/>/, "the advanced graph/runtime application must remain available on demand");
assert.match(main, /window\.setInterval\(\(\) => \{[\s\S]*readWorkbenchDepth/, "root depth must follow the Living Workspace Advanced action in the same window");

assert.match(projectContext, /Working in/, "project context must use explicit human-facing language");
assert.match(projectContext, /project\?\.path/, "the full active project path must be visible or inspectable");
assert.match(projectContext, /api\.pickProject\(\)/, "project switching must remain one action away");

assert.match(living, /What do you want to get done\?/, "the canonical surface must keep one obvious outcome composer");
assert.match(living, /api\.chat\(text\)/, "normal Mission work must still enter through the orchestrator intent path");
assert.match(living, /chef:mission-focus/, "the canvas must project the authoritative current Mission");
assert.match(living, /missionTaskIds\.has\(node\.taskId\)/, "worker nodes shown for a Mission must follow authoritative Mission task lineage");
assert.match(living, /Ask Chef to change or do anything/, "the same workspace must support natural follow-up direction");

assert.match(activity, /api\.stateRaw\(\)/, "live activity must derive from authoritative runtime state");
assert.match(activity, /latestMission\?\.taskIds/, "activity must stay bounded to the current Mission's workers");
assert.match(activity, /task\.assignedTo/, "activity must identify which worker is doing the work");
assert.match(activity, /Working/, "active workers need a plain-language state");
assert.match(activity, /Needs attention/, "worker failure must be understandable without raw runtime state");
assert.doesNotMatch(activity, /new EventSource\(/, "the activity rail must not consume another persistent browser connection");

assert.match(northStar, /Users specify outcomes\. Chef constructs the team and workspace\. The canvas explains what Chef is doing\./,
  "the authoritative North Star must lock the Chef interaction model");
assert.match(northStar, /Nodeterm shell \+ October brain/, "the product doc must preserve the researched synthesis");
assert.match(northStar, /one default surface: \*\*the Living Workspace\*\*/i, "the product doc must forbid competing main pages");
assert.match(northStar, /project name[\s\S]*project path[\s\S]*Change Project/i, "project clarity must be treated as a product requirement");
assert.match(northStar, /The canvas represents reality, not configuration/, "the graph must explain orchestration instead of being a prerequisite form");
assert.match(northStar, /Observability is part of correctness/, "silent worker execution must remain a product failure");

console.log("intent-home-ui: ok — Chef now has one project-grounded Living Workspace with outcome-first orchestration and visible work");