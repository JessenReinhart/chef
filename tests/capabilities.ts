/**
 * Chef — capability registry + permission policy tests (spec §11.2).
 */

import assert from "node:assert/strict";
import {
  capabilityRegistry,
  ROLE_POLICIES,
  type CapabilityContext,
  type PermissionMode,
} from "../src/runtime/capabilities.ts";

const ctx = (role: "engineer" | "orchestrator" | "human"): CapabilityContext => ({
  agentId: `agent-${role}`,
  workspaceId: "ws-test",
  role,
});

let passed = 0;
const test = (name: string, fn: () => void): void => {
  fn();
  passed += 1;
  console.log(`capability: ok — ${name}`);
};

test("engineer can access filesystem/terminal/git", () => {
  const c = ctx("engineer");
  assert.equal(capabilityRegistry.checkPermission(c, "filesystem"), "allow");
  assert.equal(capabilityRegistry.checkPermission(c, "terminal"), "allow");
  assert.equal(capabilityRegistry.checkPermission(c, "git"), "allow");
});

test("engineer denied spawnAgents/assignTasks/network/browser/github", () => {
  const c = ctx("engineer");
  assert.equal(capabilityRegistry.checkPermission(c, "spawnAgents"), "deny");
  assert.equal(capabilityRegistry.checkPermission(c, "assignTasks"), "deny");
  assert.equal(capabilityRegistry.checkPermission(c, "network"), "deny");
  assert.equal(capabilityRegistry.checkPermission(c, "browser"), "deny");
  assert.equal(capabilityRegistry.checkPermission(c, "github"), "deny");
});

test("engineer deploy requires approval", () => {
  assert.equal(capabilityRegistry.checkPermission(ctx("engineer"), "deploy"), "approval");
});

test("orchestrator allowed everything except deploy approval", () => {
  const c = ctx("orchestrator");
  for (const capability of ["filesystem", "terminal", "network", "browser", "git", "github", "spawnAgents", "assignTasks"] as const) {
    assert.equal(capabilityRegistry.checkPermission(c, capability), "allow");
  }
  assert.equal(capabilityRegistry.checkPermission(c, "deploy"), "approval");
});

test("human allowed all including deploy", () => {
  const c = ctx("human");
  for (const capability of ["filesystem", "terminal", "network", "browser", "git", "github", "spawnAgents", "assignTasks", "deploy"] as const) {
    assert.equal(capabilityRegistry.checkPermission(c, capability), "allow");
  }
});

test("unknown capability fails closed with deny", () => {
  const c = ctx("engineer");
  const mode: PermissionMode = capabilityRegistry.checkPermission(c, "notARealCapability" as never);
  assert.equal(mode, "deny");
});

test("custom policy overrides role baseline", () => {
  const c: CapabilityContext = {
    ...ctx("engineer"),
    customPolicy: { deploy: "deny" },
  };
  assert.equal(capabilityRegistry.checkPermission(c, "deploy"), "deny");
});

test("setPolicy mutates role baseline for future checks", () => {
  const before = capabilityRegistry.getPolicy("engineer");
  capabilityRegistry.setPolicy("engineer", { ...before, browser: "allow" });
  assert.equal(capabilityRegistry.checkPermission(ctx("engineer"), "browser"), "allow");
  capabilityRegistry.setPolicy("engineer", { ...ROLE_POLICIES.engineer });
  assert.equal(capabilityRegistry.checkPermission(ctx("engineer"), "browser"), "deny");
});

test("getPolicy returns a copy, not the internal reference", () => {
  const policy = capabilityRegistry.getPolicy("engineer");
  policy.deploy = "allow"; // mutate the copy
  assert.equal(capabilityRegistry.checkPermission(ctx("engineer"), "deploy"), "approval");
});

console.log(`capabilities: ok — ${passed} tests passed`);
