# CanvasSmith — Phase 3 UI Layout Foundation

## Task

Replace the cramped dashboard shell with the Chef visual-spec workbench layout in `web/` only. No backend or NodeForge files touched.

## Changed Files

| File | Change |
|---|---|
| `web/src/App.tsx` | Rewritten: workbench shell (toolbar / nav / canvas / inspector / console grid), Simple↔Power mode toggle, mode-driven theme, preserved `/api/state` + `/api/events` polling/SSE, preserved session send/interrupt + approval accept/reject controls (now Power Mode + inspector). |
| `web/src/CanvasPanel.tsx` | Rewritten: infinite-canvas projection with pan (pointer drag), zoom (ctrl+wheel + buttons + fit), node selection, minimap, library drag-drop plumbing. Approval accept/reject buttons preserved on approval nodes. |
| `web/src/InspectorPanel.tsx` | New: selected-node inspector shell (id, status, config, approval review buttons). |
| `web/src/NavigationPanel.tsx` | New: left navigation + searchable node library (categories, drag source, "Soon" badges for unimplemented node types). |
| `web/src/ConsolePanel.tsx` | New: bottom console with Events tab (live stream) and Chat-with-Chef tab (UI shell; no backend chat API exists). |
| `web/src/nodeCatalog.tsx` | New: node library catalog (8 node types from the visual spec table) + category SVG icons. |
| `web/src/workbench.css` | New: design tokens, grid layout, Simple (light) / Power (dark) theming, status pills/dots, buttons, responsive breakpoints (1200px, 900px), reduced-motion support. |

## Exports (new modules, for merge)

- `web/src/nodeCatalog.tsx`: `NODE_LIBRARY` (NodeCatalogEntry[]), `NodeIcon` (React component).
- `web/src/NavigationPanel.tsx`: `NavigationPanel` — props `{ onDragStart: (type: string, event: React.DragEvent) => void }`.
- `web/src/InspectorPanel.tsx`: `InspectorPanel` — props `{ selectedNode: GraphNode | null; onAcceptApproval: (node) => void; onRejectApproval: (node) => void }`.
- `web/src/ConsolePanel.tsx`: `ConsolePanel` — props `{ events: RuntimeEvent[] }`.
- `web/src/CanvasPanel.tsx`: `CanvasPanel` — props now `{ refreshTick: number; onSelectNode: (node: GraphNode | null) => void; onDropNode: (type: string, position: {x,y}) => void }`.
- `web/src/App.tsx`: `App` (unchanged export).

## Behavior Notes

- **Runtime authoritative**: canvas still fetches `/api/graph`; App still fetches `/api/state` + SSE `/api/events`. Approval resolution still POSTs `/api/approvals/{id}/{accept|reject}` with `{ approver: "dashboard" }`.
- **Mode toggle**: `data-mode` attribute on `<html>` toggles CSS theme; Simple = light (friendly), Power = dark (dense). Same projection underneath.
- **Node library**: 8 entries (Agent Task, Approval Gate implemented; Terminal, File/Data, Browser, Transform, Logic, Output marked "Soon").
- **Drop plumbing**: drag from library sets `text/chef-node-type`; canvas `onDropNode` callback exists; App logs the drop (no backend add-node API yet — intentionally extensible seam, not a fake success path).

## Verification

- `npm run build` in `web/` — passes: `tsc -b` clean, vite build emits `dist/` (21 modules).
- Browser smoke (Chromium via Vite dev + proxy to live Chef server):
  - Toolbar, node library (all 5 categories expanded), search filter narrows to matching nodes, console Events/Chat tabs switch.
  - Mode toggle flips Power↔Simple; Power Mode shows session input/send/interrupt + tasks/sessions strip.
  - `/api/state` and `/api/graph` reachable through the dev proxy (200).
  - No console errors; empty-canvas state shows "No plan graph yet."
- Approval-node Accept/Reject buttons render from `kind === "human" && type === "approval"` graph nodes (unchanged endpoint contract).

## Not Done / Known Gaps

- Canvas node-drag editing, real library→canvas node creation (no backend add-node API), terminal nodes, React Flow migration (spec target), chat backend — all future phases.
- Power Mode session controls moved from always-visible to Power-Mode-only (spec: hide runtime terminology from Simple Mode).
