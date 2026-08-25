# Chef Plugin System V1

**Status:** proposed architecture

## Goal

Chef plugins are reusable capability packages that extend what Chef can do without turning the core runtime into a collection of one-off integrations. Plugins are distinct from worker harnesses and MCP servers:

- a **harness** runs an external AI worker or terminal process;
- an **MCP server** exposes remote or local tools through the MCP protocol;
- a **Chef plugin** packages capabilities, metadata, policy, validation, lifecycle, and optional UI/node integration under Chef's authority.

The runtime remains authoritative for orchestration, state, permissions, events, artifacts, and installation state.

## Product placement

The user-facing hierarchy is:

`Chef Home -> Workbench -> Runtime detail`

Normal project work must remain possible from Chef Home. Workbench may expose plugin selection, configuration, generated artifacts, and reusable capability management. Runtime detail may expose plugin process state, permission diagnostics, execution logs, and low-level failure information.

Plugins must not become a hidden prerequisite for ordinary project navigation or Mission recovery.

## Ownership model

Every installed plugin has one ownership class:

- **builtin**: shipped and maintained with Chef;
- **authored**: explicitly installed or maintained by the user/workspace;
- **managed**: generated and maintained through Chef's Plugin Studio workflow.

Every plugin also has a scope:

- **user**: reusable across projects for one user;
- **workspace**: available only inside the owning Chef workspace/project.

Ownership and scope are durable metadata. A managed plugin can be promoted to authored, but promotion must be explicit and must preserve provenance and version history.

## Manifest

A plugin manifest is the stable contract between plugin code and Chef. V1 should include at least:

```ts
interface ChefPluginManifest {
  id: string;
  name: string;
  version: string;
  chefApiVersion: string;
  ownership: "builtin" | "authored" | "managed";
  scope: "user" | "workspace";
  entrypoint: string;
  permissions: PluginPermission[];
  tools?: PluginToolDeclaration[];
  artifactTypes?: PluginArtifactDeclaration[];
  nodeTypes?: PluginNodeDeclaration[];
}
```

The manifest is declarative. It cannot grant permissions to itself.

## Permissions and trust

Installation and execution use least privilege. Permissions are reviewed and granted by Chef or the user, not inferred from plugin code.

Examples include:

- project filesystem read/write;
- scoped command execution;
- network access to declared hosts;
- artifact creation;
- clipboard or browser access;
- access to selected secrets through brokered references rather than raw secret storage.

A generated or third-party plugin may request a permission but cannot self-authorize it. Missing permissions must fail closed with a useful product-level explanation.

## Runtime boundary

V1 may load trusted builtin plugins in-process behind the public plugin contract. Authored and managed plugins should be designed for an eventual separate-process/RPC boundary.

`import()` and worker threads are not security sandboxes. They may improve lifecycle isolation, but they do not replace an OS/process trust boundary.

Plugin crashes must not corrupt the authoritative Mission/Task state. Chef records plugin execution as normal runtime events and maps failures back to the calling Mission or Task.

## Tool and node model

A plugin is primarily a capability package, not a canvas node.

Plugins may register tools such as `spreadsheet.create`, `document.render`, or `archive.extract` without adding any node to the workspace. A plugin should register a node type only when persistent presence, direct inspection, durable state, or user interaction materially benefits the living workspace.

This avoids turning the Node Library into a mirror of every installed package.

## Artifacts

Plugin-created files must enter Chef's normal artifact model with provenance:

- plugin id and version;
- Mission/Task that requested the output;
- input artifact references when applicable;
- creation timestamp;
- deterministic metadata useful for later inspection or reproduction.

Recommended builtin capability families for the first implementation wave are:

- `chef.file` for safe file operations and archives;
- `chef.spreadsheet` for XLSX/CSV generation and transformation;
- `chef.document` for DOCX-style document output;
- `chef.presentation` for PPTX output;
- `chef.pdf` for PDF generation/manipulation.

Libraries should sit behind adapters so Chef is not permanently coupled to one format engine.

## Managed plugins and Plugin Studio

Plugin Studio is a privileged builtin workflow for reusable self-extension.

Target flow:

`user intent -> Plugin Studio -> manifest/code/tests -> isolated validation -> permission review -> install as Managed -> reuse -> repair/update/rollback -> optional promotion to Authored`

Plugin Studio may generate code, but generated code cannot patch Chef core as a shortcut for a missing plugin API. If the public plugin contract is insufficient, that limitation becomes an explicit core feature request.

Managed plugin updates are versioned. Chef keeps the previous known-good version so a failed update can roll back without losing the plugin record.

Before generating a new managed plugin, Chef should search installed plugins for an equivalent reusable capability and prefer repair or extension over duplication.

## Lifecycle

V1 lifecycle states:

`discovered -> validated -> installed -> enabled -> disabled -> uninstalled`

Managed plugins add version transitions:

`installed(v1) -> candidate(v2) -> validated(v2) -> promoted(v2)`

If candidate validation fails, v1 remains active.

Install/enable/disable/uninstall actions are durable and emit runtime events. Plugin state must be recoverable after restart.

## Discovery

Chef should support deterministic discovery from explicit plugin roots rather than arbitrary recursive code execution. Discovery reads manifests first, validates them, checks compatibility, and only then makes an implementation eligible for loading.

Duplicate plugin ids or incompatible API versions fail closed with actionable diagnostics.

## Authoring contract

A plugin entrypoint should expose one narrow registration function, for example:

```ts
export default function register(api: ChefPluginApi): void {
  api.tools.register({
    id: "example.echo",
    description: "Return text as an artifact",
    execute: async (input, context) => {
      return context.artifacts.createText(String(input.text));
    },
  });
}
```

The public API should provide brokered access to Chef services instead of exposing repository/database internals directly.

Plugin authors must not depend on private runtime classes, mutate Mission/Task records directly, bypass approval policy, or persist secrets in plugin metadata.

## Validation

A plugin candidate is installable only after:

1. manifest/schema validation;
2. Chef API compatibility validation;
3. permission declaration review;
4. deterministic plugin tests;
5. startup/load smoke test;
6. capability-specific behavioral checks where applicable.

Generated managed plugins run validation before they can become active. Validation failure must leave the previously active version untouched.

## Initial implementation slices

1. Define manifest types and validation with no dynamic loading.
2. Add builtin plugin registry and lifecycle state.
3. Move one existing safe capability behind the plugin contract as a proving case.
4. Add durable install/enable/disable state and events.
5. Add artifact provenance from plugin execution.
6. Add authored/managed plugin roots and isolated validation.
7. Add Plugin Studio generation, repair, rollback, and promotion flows.
8. Move untrusted plugin execution behind a separate-process/RPC boundary before any marketplace work.

## Acceptance criteria

- Chef remains authoritative for orchestration, permissions, state, events, and artifacts.
- Plugins cannot self-grant permissions or mutate core persistence directly.
- Tool-only plugins do not require canvas nodes.
- Plugin-created artifacts retain provenance.
- Plugin lifecycle state survives restart.
- Managed plugin updates are validated before activation and support rollback.
- A managed plugin can be explicitly promoted to authored without losing provenance/version history.
- Plugin UI follows `Chef Home -> Workbench -> Runtime detail`; normal project work is not gated behind runtime diagnostics.
- The architecture does not treat in-process module loading or worker threads as a security sandbox.
- Marketplace/discovery expansion remains deferred until trust, compatibility, crash containment, and rollback are proven.
