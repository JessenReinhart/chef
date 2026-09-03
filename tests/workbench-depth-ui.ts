import { strict as assert } from "node:assert";
import {
  nextWorkspaceDepth,
  readWorkspaceDepth,
  workspaceSurfacePlan,
} from "../web/src/canonicalWorkspaceModel.ts";

assert.equal(readWorkspaceDepth(null), "simple", "fresh sessions should start at normal Living Workspace depth");
assert.equal(readWorkspaceDepth("unexpected"), "simple", "unknown persisted values must fail safely to the normal depth");
assert.equal(readWorkspaceDepth("power"), "power", "the established power value should still reveal runtime detail");
assert.equal(nextWorkspaceDepth("simple"), "power");
assert.equal(nextWorkspaceDepth("power"), "simple");

const simple = workspaceSurfacePlan("simple");
const power = workspaceSurfacePlan("power");
assert.equal(simple.runtimeApp, false);
assert.equal(simple.livingWorkspace, true);
assert.equal(simple.homeMissionArtifacts, true, "normal users must see Mission result handoff without Power Mode");
assert.equal(power.runtimeApp, true);
assert.equal(power.livingWorkspace, false);
assert.equal(power.homeMissionArtifacts, false, "Power Mode must not duplicate the Simple Mode result surface");
assert.equal(power.contextScopes, true);
assert.equal(power.decisions, true);
assert.equal(power.missionArtifacts, true);

console.log("workbench-depth-ui: ok — progressive depth is verified through executable workspace behavior");
