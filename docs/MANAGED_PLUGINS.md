# Chef Managed Plugins and Plugin Studio

**Status:** Proposed core plugin-system requirement  
**Date:** 2026-08-23  
**Relationship:** Extends `PLUGIN_SYSTEM.md` with self-authoring, managed ownership, lifecycle, and UI semantics.

## 1. Product idea

Chef should not only consume plugins. It should be able to **cook reusable plugins from user intent**.

A user should be able to say:

> "I keep getting bank statement CSVs in this format. Make a reusable plugin that parses them, normalizes the transactions, and produces the workbook summary I use every month."

Chef can then create, test, review, install, and reuse that capability without requiring the user to author a package manually.

This turns repeated ad-hoc work into durable workspace capability.

The product principle is:

> **Chef may extend its skills, but Chef core remains authoritative and immutable to generated plugins.**

Managed plugins are inspired by the useful ownership separation of managed skills in agent harnesses such as OMP: generated/maintained capabilities have a distinct ownership boundary from user-authored capabilities. Chef expands that concept from instruction bundles into runtime plugin packages with tools, artifact handlers, optional nodes, tests, permissions, and versioned lifecycle.

## 2. Plugin is not the same thing as a node

A plugin is a **capability package**.

A node is an optional **workspace surface**.

A plugin may register any supported extension point, for example:

- callable tools;
- artifact readers and writers;
- file-format handlers;
- deterministic transforms;
- context providers;
- templates;
- triggers;
- Inspector or preview surfaces;
- Node Library node types.

Plugins must not automatically create nodes.

This prevents the Node Library from becoming a catalogue of low-level functions such as JSON parsers, ZIP extractors, date formatters, or UUID generators.

A plugin should register a node only when the capability benefits from persistent presence, state, direct inspection, or human interaction on the living canvas.

Examples:

| Plugin capability | Node? | Reason |
| --- | --- | --- |
| Spreadsheet workbook | Yes | Persistent file/artifact state, preview, inspect/edit surface |
| Browser integration | Yes | Interactive session and persistent inspectable surface |
| Database connection | Usually yes | Connection state, schema/context, direct inspection |
| JSON validation | No | Better exposed as a callable tool |
| ZIP extraction | No | Deterministic operation, no useful persistent presence |
| Markdown conversion | No | Deterministic operation, no useful persistent presence |

## 3. Plugin Studio

Chef should expose a privileged built-in **Plugin Studio** surface.

Plugin Studio is not an ordinary third-party plugin. It is Chef-owned infrastructure for producing and maintaining plugins through the public plugin contract.

Its responsibilities include:

1. understand the requested reusable capability;
2. inspect examples, files, and current workspace context;
3. define the plugin contract and tools;
4. generate the manifest and implementation;
5. generate tests and fixtures;
6. run validation in an isolated development host;
7. inspect requested permissions and capabilities;
8. present a human-readable summary;
9. request approval when installation or privileged permissions require it;
10. install the plugin into the appropriate scope;
11. record provenance and version history;
12. allow later repair or improvement of managed plugins.

Conceptual flow:

```text
USER INTENT
    |
    v
PLUGIN STUDIO
    |
    +--> understand repeated job
    +--> define tools/artifact handlers/node types
    +--> generate manifest + implementation + tests
    +--> run plugin test host
    +--> permission/security review
    +--> approval if required
    +--> install as Managed Plugin
    v
CHEF GAINS A REUSABLE CAPABILITY
```

## 4. Example interaction

User:

> "Every month I give you this bank CSV and ask you to normalize it the same way. Make that reusable."

Chef:

```text
Creating managed plugin: Bank Statement Normalizer

Tools
- bankStatement.inspect
- bankStatement.normalize
- bankStatement.toWorkbook

Reads
- CSV artifacts selected by the user

Writes
- normalized CSV
- XLSX workbook

Permissions
- workspace artifact read
- workspace artifact write

Tests
- 7 generated fixtures
- 7 passed

Ready to install.
```

After installation, the Orchestrator and agents can use those tools like any other registered Chef capability.

The user does not need to add the plugin to every Mission manually.

## 5. Ownership classes

Chef should distinguish plugin ownership explicitly.

### 5.1 Built-in

Shipped and maintained with Chef.

Examples:

- `chef.spreadsheet`
- `chef.document`
- `chef.pdf`
- `chef.plugin-studio`

Properties:

- Chef project owns the source;
- trusted distribution;
- still uses public plugin contracts where practical;
- not rewritten by Plugin Studio.

### 5.2 Authored

Owned by the human or organization.

Properties:

- user controls source and versioning;
- may be manually edited;
- Chef must not silently rewrite implementation;
- Plugin Studio may propose changes, but explicit user intent is required before modifying authored source;
- suitable for Git, team review, and publishing.

### 5.3 Managed

Created and maintained by Chef for the user.

Properties:

- generated from user intent or an explicit reuse request;
- Chef may repair or improve it within policy;
- every mutation is versioned and observable;
- existing working versions remain recoverable;
- permission expansion requires review/approval;
- clearly labeled **Managed by Chef**;
- may be promoted to Authored ownership.

### 5.4 Workspace-local

Scoped to a specific workspace/project.

This is an installation scope, not necessarily a separate ownership type. A plugin may be managed or authored while also being workspace-local.

Workspace-local plugins are appropriate when a capability only makes sense for one repository, client, data format, or project.

## 6. Proposed storage and discovery

Conceptual layout:

```text
~/.chef/
  plugins/
    authored/
      my-personal-plugin/
    managed/
      bank-statement-normalizer/
      monthly-report-builder/

<workspace>/
  .chef/
    plugins/
      authored/
      managed/
```

Exact OS paths can differ, but ownership and scope must be persisted independently of directory layout.

Chef should record at least:

```ts
interface PluginInstallation {
  pluginId: string;
  version: string;
  ownership: "builtin" | "authored" | "managed";
  scope: "user" | "workspace";
  sourceUri: string;
  createdBy?: string;
  createdFromMissionId?: string;
  enabled: boolean;
  approvedPermissions: string[];
  installedAt: number;
  updatedAt: number;
}
```

## 7. Managed plugin lifecycle

Suggested lifecycle:

```text
Draft
  |
  v
Building
  |
  v
Testing
  |
  +---- failed ----> Repairing ----+
  |                                |
  v                                |
Review / Permission Check <--------+
  |
  v
Managed / Installed
  |
  +--> Updating --> Testing --> new Managed version
  |
  +--> Disabled
  |
  +--> Promoted to Authored
```

A generated package must not become callable merely because code generation completed.

**Generated is not installed. Installed is not automatically trusted for new permissions.**

## 8. Promotion to Authored

Managed plugins should be promotable.

Typical progression:

```text
Managed Plugin
    |
used successfully over time
    |
user wants ownership / team distribution
    |
Promote to Authored
    |
normal source-controlled plugin
```

Promotion means:

- preserve current source and version history;
- change ownership metadata;
- stop automatic source mutation by Chef;
- optionally move/copy into a workspace Git path;
- generate authoring documentation if useful;
- retain provenance showing that the plugin originated from Plugin Studio.

This gives users a path from "Chef made this for me" to "our team owns this capability."

## 9. Reuse detection and suggestions

A later Chef capability may detect repeated work patterns and suggest reuse.

Examples:

- same transformation requested across several Missions;
- same script repeatedly regenerated;
- same file format repeatedly parsed with custom rules;
- same reporting structure rebuilt multiple times;
- same chain of deterministic tool operations repeatedly planned.

The Orchestrator may suggest:

> "You have used this process several times. I can turn the reusable part into a managed plugin."

Chef must **not** silently generate and install plugins merely because repetition was detected.

Explicit user intent is required to create a new managed plugin, unless a future workspace policy explicitly opts into automatic creation.

## 10. Self-extension, not unrestricted self-modification

This distinction is a hard architecture rule.

Plugin Studio may create or modify:

- plugin manifests;
- plugin implementation files;
- schemas;
- tests;
- fixtures;
- plugin-owned UI definitions;
- optional node types;
- templates;
- plugin documentation.

Plugin Studio must not silently modify Chef core runtime code in order to make a generated plugin work.

If a requested plugin requires a capability that Chef's plugin API does not expose, Plugin Studio must fail clearly, for example:

```text
Cannot complete this plugin safely.

Required Chef capability:
  workspace.notifications.send

The current Plugin API does not expose this capability.
Create a Chef core feature/PR first, then retry the plugin.
```

This prevents generated extensions from bypassing the plugin contract and turning Chef into an uncontrolled self-modifying codebase.

## 11. Permission rules for managed plugins

Self-authored code must not self-authorize.

Rules:

- generated manifests may **request** permissions;
- Chef policy decides whether permissions are allowed, denied, or approval-gated;
- a managed plugin cannot grant itself additional permissions during an update;
- permission expansion is treated as a meaningful version/security change;
- plugin code never receives Chef's unrestricted credential store;
- secrets are injected only through explicit scoped APIs;
- generated plugins do not receive direct SQLite/runtime internals;
- filesystem scope is narrow by default;
- external/network access is separately declared.

## 12. Safe build and test environment

Plugin Studio should not develop arbitrary generated code inside the authoritative runtime process.

Target architecture:

```text
Plugin Studio
     |
     v
Plugin Build Host
  - temporary working directory
  - narrow workspace fixtures
  - no Chef database handle
  - no ambient secrets
  - bounded process/runtime
     |
     v
Tests + static validation
     |
     v
Install candidate
```

For third-party or generated code, a separate process/RPC boundary remains the minimum target. Stronger OS sandbox/container isolation can be added later.

Tests should include:

- manifest validation;
- tool input schema validation;
- expected artifact outputs;
- path traversal rejection;
- denied permission behavior;
- cancellation where relevant;
- malformed input handling;
- deterministic fixtures for format-specific behavior;
- upgrade compatibility for managed updates.

## 13. Versioning and repair

Every installed managed update must create a new version or revision record.

Chef should retain enough history to answer:

- what changed;
- why Chef changed it;
- which Mission or user request initiated the change;
- whether permissions changed;
- which tests passed;
- which version was previously active.

If an update fails after installation, Chef should be able to deactivate the bad version and restore the previous known-good version.

Managed repair must not mean editing live code with no audit trail.

## 14. Plugin Studio as a canvas surface

`Plugin Studio` is a good candidate for a special built-in node because plugin creation has meaningful long-lived state and benefits from inspection.

Suggested node content:

```text
+--------------------------------------+
| Plugin Studio                        |
|                                      |
| Building: Bank Statement Normalizer  |
|                                      |
| ✓ Requirements                       |
| ✓ Manifest                           |
| ● Implementation                     |
| ○ Tests                              |
| ○ Permission review                  |
| ○ Install                            |
|                                      |
| Files | Tools | Tests | Permissions  |
+--------------------------------------+
```

The node can expose:

- current plugin build;
- generated files;
- tool contracts;
- tests and results;
- permission diff;
- logs/errors;
- install status;
- ownership and scope;
- version history;
- Promote to Authored;
- Disable / Roll Back.

Simple Mode should show plain-language progress.

Power Mode can expose source files, schemas, build output, test logs, RPC host state, and manifest details.

## 15. Plugin-provided nodes

The Plugin API may later expose optional node registration:

```ts
context.nodes.register({
  type: "bank-statement",
  title: "Bank Statement",
  category: "data",
  artifactTypes: ["text/csv"],
  inspector: "bank-statement-inspector"
});
```

Node registration is optional and subject to compatibility and UI policy.

A tool-only plugin remains a complete, valid plugin.

This keeps the core mental model clean:

> **Plugins provide skills. Nodes provide presence.**

## 16. Missions and Automations

Managed plugins integrate with existing Chef behavior instead of introducing another execution model.

### Missions

The Orchestrator can discover and call installed managed tools while planning or adapting a Mission.

### Agents

Agents can receive compatible plugin tools through their granted tool context.

### Automations

Plugin tools can appear as reusable Automation steps. A plugin-provided node may have an Automation representation when explicit dependency/control semantics are useful.

### Direct interaction

A user may open a plugin-provided surface directly without first creating a Mission when that surface supports direct interaction.

## 17. First implementation slice

Do not begin with autonomous plugin generation for arbitrary npm dependencies and unrestricted code.

Recommended sequence:

### Phase A: plugin ownership model

- add `builtin | authored | managed` metadata;
- add `user | workspace` scope;
- persist enabled/version/provenance state;
- expose plugin list/health.

### Phase B: Plugin Studio skeleton

- create a built-in Plugin Studio capability/surface;
- generate a plugin from a constrained template;
- require manifest and JSON Schema tool contracts;
- build in a separate plugin host;
- run generated tests;
- install only after validation.

### Phase C: first managed plugin type

Use a deterministic data transformation plugin as the first golden path.

Example:

```text
Input CSV
  -> custom parser/normalizer
  -> structured JSON/CSV
  -> optional spreadsheet plugin handoff
```

This is safer and easier to validate than starting with arbitrary network/API integrations.

### Phase D: artifact/node registration

- allow generated plugins to register artifact handlers;
- add optional node registration;
- expose generated surfaces on the living canvas.

### Phase E: managed updates and promotion

- repair/update managed plugin;
- permission-diff review;
- rollback;
- promote to Authored;
- Git-friendly workspace export.

## 18. Acceptance tests

The managed-plugin feature is not complete until these scenarios pass:

1. User asks Chef to make a repeated deterministic transformation reusable.
2. Plugin Studio creates a new plugin candidate without modifying Chef core.
3. The manifest declares all requested permissions before installation.
4. Generated tests run outside the authoritative runtime process.
5. A failing candidate is not installed or callable.
6. A passing candidate can be installed as `managed`.
7. The Orchestrator can discover and use its registered tool in a later Mission.
8. Restarting Chef preserves plugin ownership, version, enabled state, and provenance.
9. Updating a managed plugin creates an auditable new version.
10. Permission expansion cannot occur silently during an update.
11. A bad managed update can roll back to the previous known-good version.
12. A managed plugin can be promoted to Authored ownership.
13. After promotion, Chef does not silently rewrite its source.
14. A tool-only plugin works without registering a canvas node.
15. A plugin that benefits from persistent interaction may register an optional node.
16. Plugin Studio clearly reports when a requested capability requires a Chef core API that does not exist.

## 19. Product mantra

> **Chef can cook new skills for itself. Those skills extend Chef through a stable contract; they do not rewrite the kitchen.**
