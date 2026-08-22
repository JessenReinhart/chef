# Chef Plugin Authoring Guide

**Status:** Draft developer contract  
**Audience:** Chef core contributors and future plugin authors  
**Companion spec:** [`PLUGIN_SYSTEM.md`](./PLUGIN_SYSTEM.md)

## 1. Goal

A Chef plugin adds capabilities to the runtime without taking ownership of orchestration, persistence, scheduling, or security policy.

A well-behaved plugin should be replaceable.

If `chef.spreadsheet` changes from ExcelJS to another XLSX engine, Missions, Automations, artifact history, and user-facing semantics should continue to work.

## 2. Minimal plugin layout

Proposed package layout:

```text
chef-plugin-example/
├── chef.plugin.json
├── package.json
├── src/
│   └── index.ts
├── dist/
│   └── index.js
└── README.md
```

A workspace-local development plugin may live at:

```text
<workspace>/.chef/plugins/example/
```

User-level and package-based installation can use the same manifest contract later.

## 3. Manifest

`chef.plugin.json` declares identity, compatibility, capabilities, and permissions before code is activated.

```json
{
  "schemaVersion": 1,
  "id": "example.report-tools",
  "name": "Report Tools",
  "version": "0.1.0",
  "description": "Generate custom report artifacts.",
  "entry": "./dist/index.js",
  "chefApi": ">=1 <2",
  "capabilities": [
    "tools",
    "artifact.writer"
  ],
  "permissions": [
    "workspace.files.read",
    "workspace.artifacts.write"
  ],
  "artifactTypes": [
    "application/pdf"
  ]
}
```

### Required fields

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Manifest schema version. |
| `id` | Stable plugin identifier. Do not use a display label as identity. |
| `name` | Human-readable name. |
| `version` | Plugin SemVer version. |
| `entry` | Executable plugin entrypoint. |
| `chefApi` | Supported Chef plugin API range. |
| `capabilities` | Runtime extension surfaces used by the plugin. |
| `permissions` | Requested scopes. |

### Rules

- The manifest is validated before loading code.
- Missing permissions are denied, not inferred.
- A new plugin version cannot silently gain privileges without the runtime noticing the changed manifest.
- The UI may localize/display a friendly name, but `id` remains the stable identity.
- A plugin cannot register a tool under another plugin's namespace unless Chef explicitly allows it.

## 4. Entry module

Proposed entry contract:

```ts
import type { ChefPlugin } from "@chef/plugin-api";

const plugin: ChefPlugin = {
  async activate(context) {
    context.logger.info("Report Tools activated");
  },

  async deactivate() {
    // release plugin-owned resources
  }
};

export default plugin;
```

Activation should be idempotent from the plugin author's perspective. Chef may restart or reload a plugin after a failure or application restart.

## 5. Registering tools

Tools are the main callable surface.

```ts
export default {
  activate(context) {
    context.tools.register({
      name: "report.create",
      description: "Create a report artifact from structured sections.",
      inputSchema: {
        type: "object",
        properties: {
          fileName: { type: "string", minLength: 1 },
          title: { type: "string", minLength: 1 },
          sections: {
            type: "array",
            items: {
              type: "object",
              properties: {
                heading: { type: "string" },
                body: { type: "string" }
              },
              required: ["heading", "body"],
              additionalProperties: false
            }
          }
        },
        required: ["fileName", "title", "sections"],
        additionalProperties: false
      },
      async handler(input, call) {
        call.cancellation.throwIfCancelled();

        const bytes = await renderReport(input);

        return {
          artifact: await call.artifacts.create({
            name: input.fileName,
            mimeType: "application/pdf",
            bytes,
            metadata: {
              engine: "example-renderer"
            }
          })
        };
      }
    });
  }
};
```

### Tool naming

Use capability-oriented names:

```text
spreadsheet.create
spreadsheet.read
spreadsheet.update
pdf.merge
document.fromTemplate
archive.createZip
```

Avoid implementation-oriented names:

```text
exceljs.run
pdfkit.render
jszip.execute
```

The engine is an implementation detail and may appear in diagnostics/provenance, not in the stable user-facing tool contract.

## 6. Input schemas

Chef should use JSON Schema for tool input contracts.

Good schemas:

- reject unknown fields when practical;
- distinguish optional and required fields;
- place bounded limits on large arrays/strings where reasonable;
- use enums for closed choices;
- do not rely on the LLM to produce valid input without validation.

The runtime validates input before invoking the handler.

A validation failure is a normal tool failure, not a plugin crash.

## 7. Outputs

Prefer structured outputs and artifact references.

Good:

```ts
return {
  artifactId: artifact.id,
  sheets: ["Summary", "Transactions"],
  warnings: []
};
```

Avoid:

```ts
return "saved somewhere at C:\\temp\\thing.xlsx";
```

Chef needs durable references so results survive process exits and remain usable by other agents.

## 8. Artifact writing

Use the runtime artifact API rather than writing final outputs to arbitrary paths and hoping Chef discovers them.

The runtime should own:

- final artifact identity;
- storage path allocation;
- metadata;
- provenance;
- event emission;
- replacement/version semantics;
- atomic commit when available.

Plugins may use temporary files internally if required by a library, but temporary paths are not artifacts.

## 9. Reading workspace files

A plugin should use the scoped workspace API.

```ts
const input = await call.workspace.readFile(sourceRef);
```

Do not assume unrestricted `fs` access is part of the public contract.

This lets Chef later enforce:

- workspace boundaries;
- read-only contexts;
- approval-gated paths;
- remote/virtual filesystems;
- audit events.

## 10. Permissions

Proposed initial scopes:

### Workspace

- `workspace.files.read`
- `workspace.files.write`
- `workspace.artifacts.read`
- `workspace.artifacts.write`

### Network

- `network.fetch`

### Process

- `process.spawn`

### UI

- `ui.inspector`
- `ui.preview`

### Sensitive/runtime capabilities

These should remain uncommon and heavily gated:

- `secrets.read:<name>`
- `git.write`
- `github.write`
- `deploy.execute`

A document-generation plugin should not need GitHub or deployment access.

Principle:

> Request the smallest capability set that can perform the job.

## 11. Cancellation and timeouts

Long-running plugin calls must cooperate with cancellation.

Proposed call context:

```ts
interface PluginToolCallContext {
  cancellation: {
    signal: AbortSignal;
    throwIfCancelled(): void;
  };
}
```

Libraries that accept `AbortSignal` should receive Chef's signal.

Libraries that do not support cancellation may require process isolation or explicit checkpoints around expensive work.

A timeout/cancellation should produce a failed/cancelled tool event instead of leaving a tool permanently `running`.

## 12. Events and logging

Plugins do not write directly to the event table.

Chef should automatically emit lifecycle events such as:

```text
plugin.discovered
plugin.activated
plugin.deactivated
plugin.failed
tool.started
tool.completed
tool.failed
artifact.created
```

Plugin-authored diagnostic events may use a namespaced form:

```text
plugin.chef.spreadsheet.warning
```

Logs are diagnostic. Events are durable runtime facts. Do not use log lines as the system of record.

## 13. Errors

Use typed/structured errors when possible.

Useful categories:

- `INVALID_INPUT`
- `UNSUPPORTED_FORMAT`
- `CORRUPT_INPUT`
- `PERMISSION_DENIED`
- `ENGINE_FAILURE`
- `CANCELLED`
- `TIMEOUT`
- `OUTPUT_WRITE_FAILED`

Do not expose a giant raw library stack trace to Simple Mode users.

Power Mode may show implementation details for debugging.

## 14. Artifact-specific adapter design

A built-in format plugin should hide the engine behind a small adapter.

Example spreadsheet boundary:

```ts
interface SpreadsheetEngine {
  create(input: CreateWorkbookInput): Promise<Uint8Array>;
  inspect(bytes: Uint8Array): Promise<WorkbookSummary>;
  update?(bytes: Uint8Array, patch: WorkbookPatch): Promise<Uint8Array>;
}
```

Then:

```text
Chef tool contract
      |
chef.spreadsheet
      |
SpreadsheetEngine
   /       \
ExcelJS   future engine
```

Do not leak `Excel.Workbook`, PptxGenJS slide objects, or `PDFDocument` instances through Chef's public tool contract.

## 15. Templates

Templates are normal artifacts with lineage.

Example:

```text
company-report-template.docx
        |
document.fromTemplate
        |
Q3-review.docx
```

The generated artifact should retain:

- source template artifact ID;
- generating plugin/tool;
- engine/version;
- relevant source artifact IDs;
- creation timestamp through normal artifact metadata.

This makes generated business outputs auditable and reproducible enough for Chef's workspace model.

## 16. UI contributions

Plugins should be capability-first, UI-optional.

A plugin may eventually register:

- an artifact preview renderer;
- an Inspector section;
- a Node Library item;
- a settings panel.

But a spreadsheet plugin should still work if none of those UI surfaces are mounted.

The runtime capability remains authoritative.

### Simple Mode

Prefer familiar labels:

```text
Spreadsheets
Documents
PDF
Presentations
```

### Power Mode

May additionally show:

```text
chef.spreadsheet 0.1.0
Engine: ExcelJS 4.4.0
Permissions: files.read, artifacts.write
Tools: 4
Health: Ready
```

## 17. External plugin isolation

Built-ins may run in-process initially.

Third-party plugins should move toward a separate host process.

Proposed model:

```text
Chef Runtime
    |
Plugin Host Manager
    |
JSON-RPC / framed stdio
    |
External Plugin Process
```

The protocol should pass values and artifact/file references, not runtime object pointers.

The process boundary allows Chef to:

- terminate a hung plugin;
- restart a crashed plugin;
- limit environment variables;
- scope filesystem access;
- withhold runtime internals;
- measure execution;
- audit failures.

A process boundary alone is not a complete hostile-code sandbox. Stronger OS/container isolation remains a future hardening layer.

## 18. Testing requirements

Every plugin should test its Chef-facing contract separately from the third-party library.

Minimum contract tests:

1. valid manifest loads;
2. invalid manifest fails closed;
3. tool names register as expected;
4. invalid input never reaches the handler;
5. successful tool output creates valid artifact metadata;
6. engine failure maps to a structured Chef failure;
7. cancellation does not report success;
8. deactivation releases plugin-owned resources.

Format plugins should additionally keep fixture files generated/read by real consumers where licensing permits.

Examples:

- XLSX opened by Excel/LibreOffice;
- DOCX opened by Word/LibreOffice;
- PPTX opened by PowerPoint/LibreOffice/Keynote where available;
- PDF parsed by an independent PDF reader/library.

Schema-valid OOXML is useful, but visual QA still matters for Office formats.

## 19. Versioning

Chef API compatibility and plugin version are separate.

```json
{
  "version": "2.3.0",
  "chefApi": ">=1 <2"
}
```

Rules:

- breaking plugin behavior increments the plugin's major version;
- breaking Chef plugin API changes increment the Chef plugin API major version;
- the Plugin Manager refuses incompatible versions instead of attempting undefined behavior;
- migrations should be explicit when a plugin stores plugin-owned configuration.

## 20. Anti-patterns

Do not:

- import Chef's SQLite connection from a plugin;
- write Mission/task rows directly;
- expose raw third-party library objects as tool inputs/outputs;
- put secrets into artifact metadata;
- rely on stdout parsing as the plugin protocol;
- make plugin logs authoritative state;
- register broad filesystem/network permissions "just in case";
- make every plugin a canvas node;
- create a separate orchestration loop inside a plugin;
- make Simple Mode users understand implementation libraries.

## 21. First built-in plugin implementation order

Recommended sequence:

### 1. `chef.file`

Proves tool registration, artifact writing, MIME/extension handling, and basic permissions.

### 2. `chef.spreadsheet`

High-value demonstration for business users. Start with create/read/inspect XLSX and CSV. Keep the engine behind an adapter.

### 3. `chef.document`

Adds DOCX generation and templates.

### 4. `chef.pdf`

Adds final report generation and manipulation.

### 5. `chef.presentation`

Adds PPTX output after the artifact/template conventions are stable.

### 6. `chef.archive`

Useful for bundles/export packs and custom multi-file outputs.

This sequence validates the plugin kernel with increasingly rich artifact types instead of designing a marketplace first.
