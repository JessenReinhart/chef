import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

const main = await readFile(new URL("../web/src/main.tsx", import.meta.url), "utf8");
const home = await readFile(new URL("../web/src/IntentHome.tsx", import.meta.url), "utf8");
const onboarding = await readFile(new URL("../web/src/IntentOnboarding.tsx", import.meta.url), "utf8");

assert.match(main, /localStorage\.getItem\("chef:surface"\) === "workbench" \? "workbench" : "home"/, "fresh Chef sessions should default to the intent home");
assert.match(main, /if \(surface === "home"\)/, "home and Workbench must be explicit product surfaces");
assert.match(main, /<IntentHome onOpenWorkbench=\{openWorkbench\} \/>/, "the default surface should mount the intent-first home");
assert.match(main, /<IntentOnboarding \/>/, "the default Home should mount the first-run happy-path onboarding");
assert.match(main, /<App key=\{viewMode\} \/>/, "the existing graph UI should remain available as the Workbench");
assert.match(home, /What are we doing\?/, "the home should lead with user intent rather than graph controls");
assert.match(home, /api\.chat\(message\)/, "the primary composer must use the existing Orchestrator chat path");
assert.match(home, /Open Workbench/, "advanced inspection should stay deliberately reachable");
assert.match(home, /Needs your attention/, "approval and failure states should be surfaced in plain language");
assert.match(home, /const missionApprovals = useMemo/, "Home approvals should be projected from the current Mission instead of all workspace approvals");
assert.match(home, /approvals\.filter\(\(approval\) => ids\.has\(approval\.taskId\)\)/, "unrelated Mission approvals must not pollute the current Home status");
assert.match(home, /Chef is working/, "active work should collapse to a human-readable status");
assert.match(home, /Work complete/, "completed work should collapse to a human-readable status");
assert.doesNotMatch(home, /NodePalette|ChannelRooms|AgentContextInspector|Power Mode|PTY|sessionId/, "default home must not expose Workbench/runtime machinery");

assert.match(onboarding, /Tell Chef the outcome/, "onboarding should teach intent as the first action");
assert.match(onboarding, /Work starts automatically/, "onboarding must make the no-Run happy path explicit");
assert.match(onboarding, /Step in only when needed/, "onboarding should teach exception-driven intervention");
assert.match(onboarding, /type → send → watch → respond only if asked → result/, "onboarding should summarize the happy path in plain language");
assert.match(onboarding, /chef:intent-onboarding-complete/, "onboarding should be first-run and dismissible instead of permanently occupying Home");
assert.doesNotMatch(onboarding, /NodePalette|ChannelRooms|AgentContextInspector|Power Mode|PTY|sessionId/, "onboarding must teach the product without exposing runtime jargon");

const chatCalls = home.match(/api\.chat\(/g) ?? [];
assert.equal(chatCalls.length, 1, "the default home should have one authoritative Chef intent submission path");

console.log("intent-home-ui: ok — Chef teaches one intent-first happy path with Workbench behind progressive depth");
