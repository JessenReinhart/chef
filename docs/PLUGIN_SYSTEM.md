# Chef Plugin System

**Status:** Proposed architecture and implementation target  
**Date:** 2026-08-23  
**Scope:** Extensible capabilities for document, spreadsheet, presentation, PDF, archive, data, and future tool integrations.

## 1. Why Chef needs plugins

Chef already treats agents, tools, files, context, artifacts, Missions, and Automations as reusable runtime objects. The next step is to make capabilities extensible without hard-coding every file format or integration into the core runtime.

A user should be able to say:

> "Take this CSV, build a formatted workbook, write an executive summary, and export the final pack as PDF."

Chef should be able to satisfy that request by composing installed capabilities instead of requiring a special workflow implementation for each output type.

Plugins are therefore a **runtime extension mechanism**.

They are not a second orchestration system.

## 2. Product principle

> **Chef owns orchestration, state, permissions, events, and artifacts. Plugins provide capabilities.**

A plugin may add:

- tools that agents and the Orchestrator can call;
- artifact readers or writers;
- artifact preview/inspection support;
- file-format import/export support;
- deterministic transforms;
- optional UI surfaces or Inspector panels later;
- optional Automation nodes backed by the same runtime capability.

A plugin must not become authoritative for Mission state, task state, scheduling, permissions, or workspace persistence.

This preserves Chef's existing product rule:

> LLMs decide; the runtime validates and executes.

The same principle applies to plugins.

## 3. Plugins vs MCP vs harnesses

These concepts solve different problems.

| Concept | Purpose | Example |
| --- | --- | --- |
| Harness | Runs an AI worker or interactive agent process. | Claude Code, Codex CLI, Pi, OMP |
| MCP | Connects Chef or an agent to an external capability/server protocol. | GitHub, database, browser service |
| Plugin | Extends Chef itself with a packaged capability. | Spreadsheet writer, DOCX generator, PDF toolkit |
| Tool | A callable operation registered by a plugin, MCP server, or built-in runtime component. | `spreadsheet.create`, `pdf.merge` |
| Artifact | Durable runtime output/input produced or consumed by tools and agents. | `.xlsx`, `.docx`, `.pdf`, `.pptx`, `.zip` |

A plugin can internally use an MCP client, local library, executable, or remote API, but Chef should expose the result through one consistent tool and artifact contract.

## 4. First-class use cases

### 4.1 Spreadsheet plugin

User outcomes:

- create `.xlsx` workbooks;
- format tables, columns, number formats, and worksheets;
- create formulas and charts where the selected engine supports them;
- read or update an existing workbook;
- export CSV;
- produce a workbook artifact that remains in Chef after the agent session ends.

Suggested tools:

- `spreadsheet.create`
- `spreadsheet.read`
- `spreadsheet.update`
- `spreadsheet.exportCsv`
- `spreadsheet.inspect`

### 4.2 Document plugin

User outcomes:

- create `.docx` reports, letters, memos, and structured documents;
- populate templates;
- insert tables, headings, images, headers, and footers;
- inspect basic document metadata and structure.

Suggested tools:

- `document.create`
- `document.fromTemplate`
- `document.inspect`

### 4.3 Presentation plugin

User outcomes:

- create `.pptx` decks;
- populate existing templates;
- add tables, charts, images, and speaker notes where supported;
- preserve generated presentations as normal Chef artifacts.

Suggested tools:

- `presentation.create`
- `presentation.fromTemplate`
- `presentation.inspect`

### 4.4 PDF plugin

User outcomes:

- generate reports as PDF;
- merge, split, copy, or annotate pages;
- fill or flatten forms where supported;
- turn a generated document/report into a final delivery artifact.

Suggested tools:

- `pdf.create`
- `pdf.merge`
- `pdf.extractPages`
- `pdf.fillForm`
- `pdf.inspect`

### 4.5 Generic file and archive plugin

User outcomes:

- create text, JSON, Markdown, HTML, CSV, XML, and other deterministic files;
- package outputs into ZIP archives;
- expose custom MIME types and file extensions without changing Chef core.

Suggested tools:

- `file.write`
- `file.convert`
- `archive.createZip`
- `archive.extractZip`

## 5. Open-source library research

Research date: **2026-08-23**.

The goal is not to choose one library forever. Each format plugin should hide its implementation behind a Chef-owned interface so engines can be replaced later.

### 5.1 Spreadsheet engines

#### Recommended initial baseline: ExcelJS

- Package: `exceljs`
- License: MIT
- Strengths: mature API, XLSX/CSV read-write support, styling, formulas, tables, images, and streaming writer support.
- Trade-off: stable release `4.4.0` is old and the project has a large legacy dependency surface.
- Position: acceptable for a first production-capable adapter if Chef tests the exact features it depends on.

Sources:

- https://github.com/exceljs/exceljs
- https://www.npmjs.com/package/exceljs

#### Modern watchlist: @office-kit/xlsx

- Package: `@office-kit/xlsx`
- License: MIT
- Strengths: TypeScript-first, Node 22+, rich XLSX model, charts, images, streaming, template round-trip focus, no paid feature tier.
- Trade-off: pre-1.0 as of this research and therefore more API churn risk.
- Position: promising candidate for a future primary engine after targeted compatibility tests.

Sources:

- https://github.com/office-kit/xlsx
- https://www.npmjs.com/package/@office-kit/xlsx

#### Optional ingestion/interchange engine: SheetJS Community Edition

- Package/project: SheetJS Community Edition
- License: Apache-2.0 with required attribution.
- Strengths: extremely broad spreadsheet parsing and interchange support.
- Trade-off: advanced write-side styling, charts, images, pivots, and related capabilities are positioned in SheetJS Pro rather than Community Edition.
- Position: useful as a format ingestion/interchange adapter, not the default rich-authoring engine.

Sources:

- https://git.sheetjs.com/SheetJS/sheetjs
- https://docs.sheetjs.com/docs/miscellany/license/

#### Not recommended as the default: xlsx-populate

- License: MIT
- Strengths: template-preserving XLSX editing and simple chained API.
- Trade-off: older JS architecture and ecosystem; TypeScript support is not a strong first-class story.
- Position: only use if a specific template-preservation case proves materially better than the preferred engines.

Source:

- https://github.com/dtjohnson/xlsx-populate

### 5.2 DOCX engine

#### Recommended: docx

- Package: `docx`
- License: MIT
- Current line at research time: `9.7.x`.
- Strengths: TypeScript/JavaScript, Node and browser support, declarative document authoring, images, tables, sections, headers/footers, and template patching.
- Position: preferred initial DOCX adapter.

Sources:

- https://github.com/dolanmiu/docx
- https://www.npmjs.com/package/docx

### 5.3 PPTX engine

#### Recommended: PptxGenJS

- Package: `pptxgenjs`
- License: MIT
- Current stable line at research time: `4.0.x`.
- Strengths: mature PowerPoint generation API, tables, charts, images, shapes, templates/master slides, Node/browser support.
- Position: preferred initial presentation adapter.

Sources:

- https://github.com/gitbrent/PptxGenJS
- https://www.npmjs.com/package/pptxgenjs

#### Watchlist: @office-kit/pptx

- License: MIT
- Strengths: modern TS-first API, read/edit/save round-trip focus, schema validation, template editing, and agent-oriented documentation.
- Trade-off: newer project with a shorter production history than PptxGenJS.
- Position: evaluate later for template-preserving editing and round-trip fidelity.

Source:

- https://github.com/office-kit/pptx

### 5.4 PDF engines

#### Recommended for editing/manipulation: pdf-lib

- Package: `pdf-lib`
- License: MIT
- Strengths: create and modify PDFs, copy pages, forms, images, fonts, metadata, browser and Node support.
- Position: preferred PDF manipulation engine.

Source:

- https://github.com/Hopding/pdf-lib

#### Recommended for flowing generated reports: PDFKit

- Package: `pdfkit`
- License: MIT
- Strengths: mature streaming document generation, text layout, images, vector graphics, multi-page reports.
- Position: useful when Chef needs to author a report from scratch rather than modify an existing PDF.

Source:

- https://github.com/foliojs/pdfkit

### 5.5 Generic archive engine

#### Recommended: JSZip

- Package: `jszip`
- License: MIT or GPL-3.0-or-later; Chef can consume it under MIT.
- Strengths: create, read, and edit ZIP files in Node and browser environments.
- Position: suitable for a generic archive plugin and OOXML-related helpers where a format engine does not already bundle ZIP support.

Source:

- https://github.com/Stuk/jszip

### 5.6 Plugin contract helpers

#### Recommended for manifest and tool-schema validation: Ajv

- Package: `ajv`
- License: MIT
- Strengths: mature JSON Schema validation, TypeScript support, multiple modern JSON Schema drafts.
- Position: strong fit for validating plugin manifests and callable tool arguments.

Source:

- https://github.com/ajv-validator/ajv

#### Optional internal hook helper: hookable

- Package: `hookable`
- License: MIT
- Strengths: small, typed, async hook system.
- Position: optional internal convenience for runtime extension hooks. It must not become the plugin security or process boundary.

Source:

- https://github.com/unjs/hookable

## 6. Architecture

```text
USER / ORCHESTRATOR / AGENT / AUTOMATION
                  |
             Tool Registry
                  |
       Permission + Policy Gate
                  |
             Plugin Manager
        /          |           \
 Built-in      Trusted       External
 plugins       local         isolated
        \          |           /
             Plugin API
                  |
      Artifact + Event services
                  |
       Workspace filesystem
```

The Plugin Manager is responsible for:

- discovery;
- manifest validation;
- compatibility checks;
- enable/disable state;
- lifecycle;
- tool registration;
- permission binding;
- artifact-type registration;
- event emission;
- health reporting;
- upgrade metadata.

The Plugin Manager is **not** responsible for Mission planning or tool selection. The Orchestrator and runtime remain responsible for those decisions.

## 7. Plugin manifest

Initial proposed format:

```json
{
  "schemaVersion": 1,
  "id": "chef.spreadsheet",
  "name": "Spreadsheets",
  "version": "0.1.0",
  "description": "Create and inspect spreadsheet artifacts.",
  "entry": "./dist/index.js",
  "chefApi": ">=1 <2",
  "capabilities": [
    "tools",
    "artifact.reader",
    "artifact.writer"
  ],
  "permissions": [
    "workspace.files.read",
    "workspace.artifacts.write"
  ],
  "artifactTypes": [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/csv"
  ]
}
```

Rules:

- plugin IDs are globally unique within an installation;
- versions use SemVer;
- `chefApi` defines compatibility with Chef's plugin API;
- a plugin declares permissions before activation;
- unknown manifest fields may be preserved but must not silently grant capability;
- invalid or incompatible plugins do not load;
- disabled plugins register no callable tools.

## 8. Runtime plugin API

Initial TypeScript direction:

```ts
export interface ChefPlugin {
  activate(context: PluginContext): Promise<void> | void;
  deactivate?(): Promise<void> | void;
}

export interface PluginContext {
  readonly manifest: PluginManifest;
  readonly tools: ToolRegistrationApi;
  readonly artifacts: ArtifactApi;
  readonly events: PluginEventApi;
  readonly workspace: ScopedWorkspaceApi;
  readonly logger: PluginLogger;
}
```

Plugins receive a scoped API, not the runtime database object.

They must not directly mutate:

- Mission records;
- Task lifecycle state;
- approval state;
- event storage;
- runtime-owned SQLite tables;
- arbitrary workspace files outside granted scopes.

## 9. Tool registration

Plugins register deterministic callable tools.

```ts
context.tools.register({
  name: "spreadsheet.create",
  description: "Create an XLSX workbook artifact.",
  inputSchema: {
    type: "object",
    properties: {
      fileName: { type: "string" },
      sheets: { type: "array" }
    },
    required: ["fileName", "sheets"],
    additionalProperties: false
  },
  handler: async (input, callContext) => {
    // create bytes using the selected adapter
    // store via callContext.artifacts rather than returning an arbitrary path
  }
});
```

Tool rules:

- inputs are schema-validated before execution;
- outputs use structured values and artifact references;
- every call emits start/completion/failure events;
- cancellation propagates through the runtime call context;
- plugins do not receive raw secrets unless the declared capability requires them;
- destructive or privileged capabilities remain approval-gated by Chef policy.

## 10. Artifact contract

Generated files must become normal Chef artifacts.

Suggested metadata:

```ts
interface PluginArtifactMetadata {
  pluginId: string;
  toolName: string;
  mimeType: string;
  extension?: string;
  sourceArtifactIds?: string[];
  templateArtifactId?: string;
  engine?: string;
  engineVersion?: string;
}
```

This gives Chef provenance such as:

> `monthly-close.xlsx` was created by `chef.spreadsheet` using `spreadsheet.create`, based on `transactions.csv`.

Artifact creation must be atomic where practical. A failed generation should not leave a successful-looking artifact record pointing to a partial file.

## 11. Security and trust model

### 11.1 Built-in plugins

Plugins shipped with Chef are trusted code but still use the public plugin API. This prevents built-ins from becoming special undocumented runtime shortcuts.

### 11.2 Local trusted plugins

A user may install a local plugin from a directory/package. Chef displays declared capabilities and permissions before enabling it.

### 11.3 Third-party plugins

Do not treat arbitrary JavaScript loaded with `import()` as safely sandboxed.

Initial external-plugin direction:

- run external plugins in a separate process;
- communicate through a narrow RPC protocol;
- grant scoped filesystem paths and runtime capabilities;
- do not pass the SQLite connection or unrestricted runtime internals;
- terminate misbehaving plugin hosts without corrupting the workspace;
- record plugin crashes and denied operations as events.

Worker threads can improve fault isolation but are not a complete security sandbox. Stronger OS/container isolation can be added later for untrusted marketplace plugins.

## 12. Discovery and installation

Proposed search locations:

1. Chef built-ins.
2. Workspace-local `.chef/plugins/`.
3. User-level Chef plugin directory.
4. Installed package references in Chef settings.
5. Remote registry/marketplace later.

V0 should prefer explicit local installation over an open marketplace.

A marketplace creates supply-chain and trust problems that are not necessary to prove the plugin architecture.

## 13. UI direction

### Simple Mode

Show outcomes and familiar app/file language:

- Spreadsheets
- Documents
- Presentations
- PDF
- Archive

Do not expose implementation names such as ExcelJS, `docx`, or Ajv.

Example:

> **Spreadsheets**  
> Create and edit Excel workbooks and CSV files.  
> Installed · Ready

### Power Mode

Expose:

- plugin ID and version;
- source/location;
- enabled state;
- permissions;
- registered tools;
- artifact types;
- health/errors;
- engine/adapter details;
- execution events;
- compatibility status.

Plugins may add items to the Node Library only when a visual node materially improves the experience. A plugin does not automatically need a node.

## 14. Relationship to Missions and Automations

### Mission

The Orchestrator may choose installed plugin tools while adapting a plan.

Example:

```text
User intent
  -> inspect transactions.csv
  -> analyze anomalies
  -> spreadsheet.create
  -> document.create
  -> pdf.create
  -> verify artifacts
  -> report outcome
```

No pre-authored workflow is required.

### Automation

The same tools can be pinned into repeatable Automation steps.

Example:

```text
Monthly trigger
  -> spreadsheet.read
  -> analysis task
  -> human approval
  -> spreadsheet.create
  -> pdf.create
  -> deliver
```

The plugin contract therefore serves both the living workspace and deterministic Automation without conflating them.

## 15. Recommended implementation phases

### P0 - plugin kernel

- define `PluginManifest` and `ChefPlugin` contracts;
- manifest validation;
- built-in plugin discovery;
- enable/disable state;
- tool registration;
- scoped artifact API;
- plugin lifecycle events;
- no marketplace;
- trusted built-ins run in-process.

### P1 - useful output plugins

Ship built-in plugins using the same public contract:

1. `chef.file`
2. `chef.spreadsheet`
3. `chef.document`
4. `chef.pdf`
5. `chef.presentation`
6. `chef.archive`

Do not require all six to reach production quality simultaneously. Spreadsheet + document + PDF provides the strongest initial non-developer demo.

### P2 - previews and templates

- artifact preview adapters;
- template discovery;
- template provenance;
- document/spreadsheet/presentation template workflows;
- Simple Mode "Create with Chef" actions.

### P3 - external plugins

- process-isolated plugin host;
- RPC boundary;
- local package installation;
- compatibility and migration reporting;
- crash containment;
- per-plugin permission grants.

### P4 - registry/ecosystem

Only after the local plugin model is proven:

- signed metadata;
- publisher identity;
- registry search;
- update channels;
- integrity hashes;
- reviews/trust signals;
- organization allowlists;
- optional remote capabilities.

## 16. Acceptance tests

### Plugin kernel

1. Chef discovers a valid built-in plugin and registers its tools.
2. An invalid manifest is rejected without crashing the runtime.
3. An incompatible `chefApi` version is reported as disabled/incompatible.
4. Disabling a plugin removes its tools from new calls.
5. A plugin cannot obtain runtime database access through the public context.
6. Tool input is rejected before handler execution when it fails schema validation.
7. Tool start, completion, and failure become runtime events.
8. Cancellation reaches a running plugin tool.

### Artifact behavior

9. A spreadsheet tool creates an `.xlsx` artifact with provenance metadata.
10. A document tool creates a `.docx` artifact and survives Chef restart.
11. A PDF tool can consume an existing artifact by reference and produce a new artifact.
12. A failed writer does not leave a completed artifact pointing to a partial output.

### Product behavior

13. The Orchestrator can use plugin tools during a Mission without a pre-built Automation.
14. An Automation can invoke the same tool deterministically.
15. Simple Mode presents the capability as "Spreadsheets" rather than an implementation/library name.
16. Power Mode can inspect plugin version, permissions, tools, and recent failures.

## 17. Non-goals for the first implementation

- no arbitrary npm marketplace execution by default;
- no claim that worker threads are a secure sandbox;
- no plugin-owned Mission scheduler;
- no plugin-owned SQLite schema access as the normal extension mechanism;
- no requirement that every plugin exposes a canvas node;
- no requirement to support every Office feature in the first release;
- no dependency on Microsoft Office being installed;
- no coupling of the public plugin contract to ExcelJS, PptxGenJS, or any other specific engine.

## 18. Recommended first demo

The strongest first plugin demo is intentionally non-developer-facing:

```text
User drops transactions.csv into Chef.

User:
"Make me a clean monthly finance workbook, summarize the biggest movements,
and give me a PDF report."

Chef:
- reads the CSV
- delegates analysis to an agent
- calls spreadsheet.create
- calls document/PDF capability
- stores both artifacts with provenance
- shows previews/results
- reports the outcome in plain language
```

This proves that Chef is not only an engineering orchestrator. It is a general AI workbench whose runtime can acquire new practical skills through plugins.

## 19. Design mantra

> **Plugins add skills. Chef keeps control.**

> **Capabilities are replaceable. Artifacts, state, permissions, and provenance are not.**
