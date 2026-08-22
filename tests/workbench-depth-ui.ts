import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

const main = await readFile(new URL("../web/src/main.tsx", import.meta.url), "utf8");
const app = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../web/src/workbench-depth.css", import.meta.url), "utf8");

assert.match(main, /type WorkbenchDepth = "simple" \| "power"/, "the existing view-mode contract should remain an internal compatibility detail");
assert.match(main, /const toggleRuntimeDetails = \(\) =>/, "Workbench should expose depth as runtime-detail disclosure");
assert.match(main, /localStorage\.setItem\("chef:view-mode", next\)/, "runtime-detail depth should preserve the existing persisted mode contract");
assert.match(main, /Runtime details/, "Workbench should name the advanced depth by what it reveals, not by user persona");
assert.match(main, /aria-pressed=\{runtimeDetailsVisible\}/, "the runtime-detail control should expose its current state accessibly");
assert.match(main, /runtimeDetailsVisible \? "Shown" : "Hidden"/, "the depth control should communicate whether runtime detail is visible");
assert.match(css, /\.mode-switch\s*\{\s*display:\s*none;/, "the legacy Simple/Power segmented switch should not compete with the depth affordance");
assert.match(app, /localStorage\.getItem\("chef:view-mode"\) === "power" \? "power" : "simple"/, "App should continue consuming the established mode contract without runtime changes");
assert.match(app, /mode === "power"/, "existing deep-detail projections should remain driven by the established power-mode value");

console.log("workbench-depth-ui: ok — Workbench reveals runtime detail through progressive depth without changing runtime semantics");
