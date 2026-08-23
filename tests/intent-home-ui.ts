import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

const main = await readFile(new URL("../web/src/main.tsx", import.meta.url), "utf8");
const home = await readFile(new URL("../web/src/IntentHome.tsx", import.meta.url), "utf8");
const threadApi = await readFile(new URL("../web/src/threadApi.ts", import.meta.url), "utf8");
const onboarding = await readFile(new URL("../web/src/IntentOnboarding.tsx", import.meta.url), "utf8");
const rooms = await readFile(new URL("../web/src/ChannelRoomsFeature.tsx", import.meta.url), "utf8");

assert.match(main, /localStorage\.getItem\("chef:surface"\) === "workbench" \? "workbench" : "home"/, "fresh Chef sessions should default to the intent home");
assert.match(main, /if \(surface === "home"\)/, "home and Workbench must be explicit product surfaces");
assert.match(main, /<IntentHome onOpenWorkbench=\{openWorkbench\} \/>/, "the default surface should mount the intent-first home");
assert.match(main, /<IntentOnboarding \/>/, "the default Home should mount the first-run happy-path onboarding");
assert.match(main, /<App key=\{viewMode\} \/>/, "the existing graph UI should remain available as the Workbench");
assert.match(main, /<ChannelRoomsFeature \/>/, "Rooms should remain available from the Workbench depth");
assert.match(home, /What are we doing\?/, "the home should lead with user intent rather than graph controls");
assert.match(home, /listThreads\(\)/, "Simple Mode must load durable workspace Threads");
assert.match(home, /threadMessages\(selected\.id\)/, "Simple Mode history must come from the selected Thread");
assert.match(home, /sendThreadMessage\(threadId, message\)/, "the primary composer must continue work through the selected Thread");
assert.match(home, /\+ New thread/, "Thread creation must be available directly from Simple Mode");
assert.match(home, /createThread\("New thread"\)/, "Simple Mode must be able to create an explicit new Thread");
assert.match(home, /renameSelectedThread\(\)/, "Thread rename must be available directly from Home");
assert.match(home, /archiveSelectedThread\(\)/, "Thread archive must be available directly from Home");
assert.match(home, /nextThreads\.find\(\(thread\) => thread\.status === "active"\)/, "archiving the selected Thread must move selection to another active Thread when possible");
assert.match(home, /saveSelectedThreadId\(nextActive\?\.id \?\? null\)/, "archiving must not leave an archived Thread persisted as the active selection");
assert.match(home, /mission\.metadata\?\.threadId === selectedThreadId/, "Mission status on Home must be scoped to the selected Thread");
assert.match(home, /const recentPriorMissions = useMemo/, "Home must derive bounded prior Mission history from the selected Thread projection");
assert.match(home, /mission\.id !== latestMission\?\.id/, "prior Mission history must not duplicate the current Mission");
assert.match(home, /\.slice\(0, 3\)/, "prior Mission history must stay bounded on the default Home surface");
assert.match(home, /Recent Mission outcomes/, "selected Thread prior outcomes must be inspectable without opening Workbench");
assert.match(home, /missionOutcomePresentation\(mission\.status\)/, "prior Mission history must use human-readable outcome labels");
assert.match(home, /Recent conversation/, "selected Thread history must be visible without opening Workbench");
assert.match(home, /saveSelectedThreadId/, "selected Thread should survive reload when possible");
assert.match(threadApi, /method: "PATCH"/, "Thread rename must use the existing PATCH lifecycle route");
assert.match(threadApi, /\/api\/threads\/\$\{encodeURIComponent\(threadId\)\}\/archive/, "Thread archive must use the canonical archive route");
assert.match(threadApi, /\/api\/threads\/\$\{encodeURIComponent\(threadId\)\}\/chat/, "Thread sends must use the canonical Thread-scoped endpoint");
assert.match(threadApi, /\/api\/threads\/\$\{encodeURIComponent\(threadId\)\}\/messages/, "Thread history must use the canonical Thread-scoped endpoint");
assert.doesNotMatch(home, /api\.chat\(|api\.chatMessages\(/, "Simple Mode must not silently fall back to workspace-global chat continuity");
assert.match(home, /Open Workbench/, "advanced inspection should stay deliberately reachable");
assert.match(home, /Needs your attention/, "approval and failure states should be surfaced in plain language");
assert.match(home, /const missionApprovals = useMemo/, "Home approvals should be projected from the current Mission instead of all workspace approvals");
assert.match(home, /approvals\.filter\(\(approval\) => ids\.has\(approval\.taskId\)\)/, "unrelated Mission approvals must not pollute the current Home status");
assert.match(home, /api\.retryNode\(taskId\)/, "failed work must be retryable directly from Simple Mode");
assert.match(home, /"Retry"/, "Simple Mode must present a plain-language retry action");
assert.match(home, /task\.status === "blocked" && !approvalTaskIds\.has\(task\.id\)/, "retry must not bypass a pending approval gate");
assert.match(home, /Chef is working/, "active work should collapse to a human-readable status");
assert.match(home, /Work complete/, "completed work should collapse to a human-readable status");
assert.doesNotMatch(home, /NodePalette|ChannelRooms|AgentContextInspector|Power Mode|PTY|sessionId/, "default home must not expose Workbench/runtime machinery");

assert.match(onboarding, /Tell Chef the outcome/, "onboarding should teach intent as the first action");
assert.match(onboarding, /Work starts automatically/, "onboarding must make the no-Run happy path explicit");
assert.match(onboarding, /Step in only when needed/, "onboarding should teach exception-driven intervention");
assert.match(onboarding, /type → send → watch → respond only if asked → result/, "onboarding should summarize the happy path in plain language");
assert.match(onboarding, /chef:intent-onboarding-complete/, "onboarding should be first-run and dismissible instead of permanently occupying Home");
assert.doesNotMatch(onboarding, /NodePalette|ChannelRooms|AgentContextInspector|Power Mode|PTY|sessionId/, "onboarding must teach the product without exposing runtime jargon");

assert.doesNotMatch(rooms, /chef:view-mode|mode === "power"|setEnabled/, "Rooms should be a Workbench capability instead of a legacy Power-mode capability");
assert.match(rooms, /if \(!open\) return;/, "closed Rooms should not poll their channel endpoint");
assert.match(rooms, /if \(!open \|\| !selectedChannel\)/, "closed Rooms should not poll message history");

const threadSendCalls = home.match(/sendThreadMessage\(/g) ?? [];
assert.equal(threadSendCalls.length, 1, "the default home should have one authoritative Thread-scoped Chef intent submission path");

console.log("intent-home-ui: ok — Chef teaches one Thread-scoped intent flow with lifecycle, prior outcomes, recovery, and Workbench behind progressive depth");
