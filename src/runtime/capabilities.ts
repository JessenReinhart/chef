/**
 * Chef P0 — Capability Registry + Permission Policy (spec §11.2)
 *
 * Capabilities: filesystem, terminal, network, browser, git, github,
 * spawnAgents, assignTasks, deploy.
 *
 * Defaults per spec §11.2:
 *   - Engineer: filesystem, terminal, git allowed; spawnAgents denied;
 *     deploy requires approval
 *   - Orchestrator: all except deploy (deploy requires approval)
 *   - Human: all
 *
 * Missing capability in an effective policy → deny (fail closed).
 */

import type { AgentId, WorkspaceId } from "../core/types.ts";

export type Capability =
  | "filesystem"
  | "terminal"
  | "network"
  | "browser"
  | "git"
  | "github"
  | "spawnAgents"
  | "assignTasks"
  | "deploy";

export type PermissionMode = "allow" | "deny" | "approval";

export interface CapabilityPolicy {
  readonly [capability: string]: PermissionMode;
}

export type Role = "engineer" | "orchestrator" | "human";

export const DEFAULT_CAPABILITIES: readonly Capability[] = [
  "filesystem",
  "terminal",
  "network",
  "browser",
  "git",
  "github",
  "spawnAgents",
  "assignTasks",
  "deploy",
] as const;

export const ROLE_POLICIES: Record<Role, CapabilityPolicy> = {
  engineer: {
    filesystem: "allow",
    terminal: "allow",
    network: "deny",
    browser: "deny",
    git: "allow",
    github: "deny",
    spawnAgents: "deny",
    assignTasks: "deny",
    deploy: "approval",
  },
  orchestrator: {
    filesystem: "allow",
    terminal: "allow",
    network: "allow",
    browser: "allow",
    git: "allow",
    github: "allow",
    spawnAgents: "allow",
    assignTasks: "allow",
    deploy: "approval",
  },
  human: {
    filesystem: "allow",
    terminal: "allow",
    network: "allow",
    browser: "allow",
    git: "allow",
    github: "allow",
    spawnAgents: "allow",
    assignTasks: "allow",
    deploy: "allow",
  },
};

export interface CapabilityContext {
  agentId: AgentId;
  workspaceId: WorkspaceId;
  role: Role;
  customPolicy?: CapabilityPolicy;
}

/**
 * Role-keyed permission policy store. Custom per-call policies
 * (CapabilityContext.customPolicy) override the role baseline for that
 * single check; the store itself is keyed by role.
 */
export class CapabilityRegistry {
  readonly #policies: Record<Role, CapabilityPolicy> = {
    engineer: { ...ROLE_POLICIES.engineer },
    orchestrator: { ...ROLE_POLICIES.orchestrator },
    human: { ...ROLE_POLICIES.human },
  };

  getPolicy(role: Role): CapabilityPolicy {
    return { ...this.#policies[role] };
  }

  setPolicy(role: Role, policy: CapabilityPolicy): void {
    this.#policies[role] = { ...policy };
  }

  /** Effective mode for a capability: custom policy first, then role baseline; unknown → deny. */
  checkPermission(context: CapabilityContext, capability: Capability): PermissionMode {
    const effective = context.customPolicy ?? this.#policies[context.role];
    return effective[capability] ?? "deny";
  }
}

export const capabilityRegistry = new CapabilityRegistry();