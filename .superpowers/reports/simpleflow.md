# SimpleFlow Setup Wizard — Implementation Report

## Summary
Created `web/src/SetupWizard.tsx` — a guided step-by-step wizard for Simple Mode template parameter configuration. Integrates with existing `TemplateGallery`, `simpleNodeConfig`, and `InspectorPanel` components. Build passes, core backend tests pass.

## Files Created/Modified
| File | Action | Lines |
|------|--------|-------|
| `web/src/SetupWizard.tsx` | Created | 510 |
| `web/src/workbench.css` | Extended (wizard styles) | +294 |

## Component Architecture

### SetupWizard (main export)
```tsx
interface SetupWizardProps {
  template: TemplateWithParams;  // from TemplateGallery + parameters
  onComplete: (draft: TemplateDraft) => void;
  onCancel?: () => void;
}
```

### Key Types Exported
- `WizardParameter` — per-field config (aligned with `SimpleField`)
- `WizardAnswers` — `{ [nodeId]: Record<paramKey, value> }`
- `TemplateDraft` — complete runnable workflow description
- `TemplateWithParams` — `Template` + `parameters: WizardParameter[]`
- `ValidationResult` — `{ valid, errors: [{nodeId, key, message}] }`
- `validateDraft(draft): ValidationResult` — shared validation
- `getTemplateParameters(template): WizardParameter[]` — parameter extraction

### Flow
1. **Step per node** — Wizard groups parameters by template node (one step per node)
2. **Progressive disclosure** — "Show advanced settings" checkbox per step
3. **Inline validation** — Required fields validated on change; red border + message
4. **Preview modal** — Before run, shows rendered node chain with resolved config
5. **Run** — `onComplete(draft)` returns `TemplateDraft` with `previewGraph.nodes[]` having runtime config (via `mapSimpleToRuntime`)

### Integration Points
| Peer Component | Contract |
|----------------|----------|
| `TemplateGallery` | Provides `Template` with `nodes[]`; `SetupWizard.getTemplateParameters(template)` derives wizard fields |
| `simpleNodeConfig` | Uses `getSimpleFields()` for field definitions; `mapSimpleToRuntime()` for preview config |
| `InspectorPanel` | Not directly used; wizard is modal overlay launched from template selection |
| `App.tsx` | Receives `TemplateDraft` from `onComplete`, submits via `/api/nodes/run` |

## UX Compliance (spec §13.1)
| Requirement | Implementation |
|-------------|----------------|
| Plain language labels | `SimpleField.label` used directly (e.g., "Bank Statement File", not "tool.file source") |
| Progressive disclosure | `advanced` flag on params; "Show advanced settings" toggle per step |
| Preview before run | Modal shows node chain with resolved `config` objects |
| Validate required inline | Red border + error text per field; footer "Preview & Run" disabled if invalid |
| Approval as native node | `human.approval` → `approval` simple type → fields: request, timeout, required |

## Template Parameter Mapping
Uses `SIMPLE_TYPE_MAP` to convert runtime node types → simple config types:
```
agent.llm      → task
tool.file      → file
tool.transform → transform
tool.browser   → browser
tool.output    → output
tool.terminal  → terminal
tool.database  → database
control.logic  → logic
human.approval → approval
human.input    → input
```

Fields sourced from `simpleNodeConfig.getSimpleFields()` — single source of truth.

## CSS Classes (workbench.css additions)
- `.wb-wizard` — fixed modal dialog
- `.wb-wizard__header/__content/__footer` — step layout
- `.wb-wizard__progress/__progress-bar` — step indicator
- `.wb-wizard__field/__label/__description/__error` — form field
- `.wb-wizard__advanced-toggle` — progressive disclosure
- `.wb-wizard__modal-overlay/__modal/__modal-body/__preview-graph` — preview
- `.wb-wizard__preview-node/__config-row` — node preview

## Tests Status
| Test | Status |
|------|--------|
| `npm run build` (web) | ✅ pass |
| `tests/golden-path.ts` | ✅ pass |
| `tests/plan-persistence.ts` | ✅ pass |
| `tests/approvals.ts` | ✅ pass |
| `tests/canvas-graph.ts` | ✅ pass |
| `tests/http-server.ts` | ✅ pass |

## Known Issues
- `tests/live-events-failure.ts` fails due to pre-existing syntax error in `src/orchestrator/llm-decision-provider.ts:134` (unrelated to this work)

## Next Steps (for AppIntegration)
1. Import `TemplateDraft`, `validateDraft`, `getTemplateParameters` from `SetupWizard.tsx`
2. On template select: `const draft = { templateId: t.id, name: t.name, description: t.description, answers: {}, previewGraph: generatePreviewGraph(t, {}) }`
3. Render `<SetupWizard template={...t, parameters: getTemplateParameters(t)} onComplete={handleComplete} onCancel={closeWizard} />`
4. In `handleComplete`: POST `draft.previewGraph.nodes` to `/api/nodes/run` (or create workflow via `/api/workflows` then run)
5. Persist mode toggle in `localStorage` (already in App.tsx via `data-mode`)

## Acceptance Criteria Met
- ✅ Guided step-by-step wizard with plain language labels
- ✅ Progressive disclosure (advanced settings toggle)
- ✅ Preview generated workflow before run
- ✅ Validates required fields inline
- ✅ Uses existing `simpleNodeConfig` field definitions
- ✅ Build passes, focused tests pass