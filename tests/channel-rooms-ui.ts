import { strict as assert } from "node:assert";
import { workspaceSurfacePlan } from "../web/src/canonicalWorkspaceModel.ts";

const simple = workspaceSurfacePlan("simple");
assert.equal(simple.rooms, false, "Rooms should stay out of the normal Living Workspace so they do not compete with outcome-first work");
assert.equal(simple.runtimeApp, false, "the normal surface must not mount the advanced runtime tree");

const power = workspaceSurfacePlan("power");
assert.equal(power.rooms, true, "Rooms should remain available when runtime details are intentionally opened");
assert.equal(power.runtimeApp, true, "Rooms and the advanced runtime surface should share the same deliberate depth");
assert.equal(power.livingWorkspace, false, "opening runtime details must replace the streaming Living Workspace rather than mount both trees");

console.log("channel-rooms-ui: ok — Rooms depth is verified through executable workspace behavior");
