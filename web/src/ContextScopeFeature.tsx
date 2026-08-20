import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "./api";
import type { ContextZone, ContextZoneInput } from "./types";

type Bounds = { x: number; y: number; width: number; height: number };
type CanvasNode = { id: string; label: string; position: { x: number; y: number } };

const VIEW_KEY = "chef:canvas:view";
const readViewport = () => {
  try {
    const raw = localStorage.getItem(VIEW_KEY);
    return raw ? JSON.parse(raw) as { x: number; y: number; zoom: number } : { x: 0, y: 0, zoom: 1 };
  } catch {
    return { x: 0, y: 0, zoom: 1 };
  }
};

export function ContextScopeFeature() {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [scopes, setScopes] = useState<ContextZone[]>([]);
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const [viewport, setViewport] = useState(readViewport);
  const [drawing, setDrawing] = useState(false);
  const [draft, setDraft] = useState<Bounds | null>(null);
  const [inspectedScopeId, setInspectedScopeId] = useState<string | null>(null);
  const [scopeAction, setScopeAction] = useState<string | null>(null);
  const [scopeError, setScopeError] = useState<string | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const find = () => setHost(document.querySelector(".react-flow") as HTMLElement | null);
    find();
    const observer = new MutationObserver(find);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [nextScopes, state] = await Promise.all([
        api.contextZones(),
        api.stateRaw(),
      ]);
      setScopes(nextScopes);
      setNodes(state.canvasNodes.map((node) => ({ id: node.id, label: node.label, position: node.position })));
    } catch {
      // The feature is additive; the base canvas remains usable if the scope API is unavailable.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      setViewport(readViewport());
      void refresh();
    }, 1500);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const screenToFlow = useCallback((p: { x: number; y: number }) => ({
    x: (p.x - viewport.x) / viewport.zoom,
    y: (p.y - viewport.y) / viewport.zoom,
  }), [viewport]);

  const rects = useMemo(() => scopes.map((scope) => ({
    scope,
    x: scope.bounds.x * viewport.zoom + viewport.x,
    y: scope.bounds.y * viewport.zoom + viewport.y,
    width: scope.bounds.width * viewport.zoom,
    height: scope.bounds.height * viewport.zoom,
  })), [scopes, viewport]);

  const nodeLabels = useMemo(() => new Map(nodes.map((node) => [node.id, node.label])), [nodes]);

  const begin = (e: React.PointerEvent) => {
    if (!drawing || e.button !== 0) return;
    const p = { x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY };
    startRef.current = p;
    setDraft({ x: p.x, y: p.y, width: 0, height: 0 });
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const move = (e: React.PointerEvent) => {
    const start = startRef.current;
    if (!start) return;
    const x = e.nativeEvent.offsetX;
    const y = e.nativeEvent.offsetY;
    setDraft({ x: Math.min(start.x, x), y: Math.min(start.y, y), width: Math.abs(x - start.x), height: Math.abs(y - start.y) });
  };

  const finish = async (e: React.PointerEvent) => {
    const start = startRef.current;
    if (!start) return;
    const x = e.nativeEvent.offsetX;
    const y = e.nativeEvent.offsetY;
    startRef.current = null;
    setDraft(null);
    setDrawing(false);

    const rect = { x: Math.min(start.x, x), y: Math.min(start.y, y), width: Math.abs(x - start.x), height: Math.abs(y - start.y) };
    if (rect.width < 40 || rect.height < 40) return;

    const a = screenToFlow({ x: rect.x, y: rect.y });
    const b = screenToFlow({ x: rect.x + rect.width, y: rect.y + rect.height });
    const memberNodeIds = nodes
      .filter((node) => node.position.x >= a.x && node.position.x <= b.x && node.position.y >= a.y && node.position.y <= b.y)
      .map((node) => node.id)
      .sort();

    try {
      await api.createContextZone({
        name: `Shared Context${memberNodeIds.length ? ` (${memberNodeIds.length} nodes)` : ""}`,
        bounds: { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y },
        contextRefs: [],
        memberNodeIds,
      });
      await refresh();
    } catch {
      // Creation errors are surfaced by the runtime; keep the canvas interaction non-blocking.
    }
  };

  const updateScope = async (scope: ContextZone, patch: Partial<ContextZoneInput>, action: string) => {
    setScopeAction(`${scope.id}:${action}`);
    setScopeError(null);
    try {
      await api.updateContextZone(scope.id, patch);
      await refresh();
    } catch (error) {
      setScopeError(error instanceof Error ? error.message : "Failed to update shared context");
    } finally {
      setScopeAction(null);
    }
  };

  const remove = async (id: string) => {
    try {
      await api.deleteContextZone(id);
      if (inspectedScopeId === id) setInspectedScopeId(null);
      await refresh();
    } catch {
      // Best-effort UI action; the next refresh reconciles the rendered scopes.
    }
  };

  if (!host) return null;

  return createPortal(
    <div className="absolute inset-0 z-[6] pointer-events-none" style={{ overflow: "visible" }}>
      {rects.map(({ scope, x, y, width, height }) => (
        <div key={scope.id} className="absolute rounded-xl border-2 border-dashed border-cyan-500/50 bg-cyan-500/5 pointer-events-auto" style={{ left: x, top: y, width, height }}>
          <div className="absolute -top-6 left-2 flex items-center gap-2 rounded-t-md bg-[#0d1117]/90 px-2 py-1 text-[10px] text-cyan-300">
            <span>◈</span>
            <button onClick={() => { setScopeError(null); setInspectedScopeId((current) => current === scope.id ? null : scope.id); }} title="Inspect shared context">
              {scope.name}
            </button>
            <span className="text-[#8b949e]">{scope.memberNodeIds.length} members · {scope.contextRefs.length} refs</span>
            <button className="text-red-400 hover:text-red-300" onClick={() => void remove(scope.id)}>×</button>
          </div>
          {inspectedScopeId === scope.id && (
            <div className="context-zone-members w-[320px] max-h-[420px] overflow-y-auto space-y-3">
              <div>
                <strong>Shared Context</strong>
                <small className="block mt-1">References here are durable and are injected into pending or assigned member tasks before dispatch.</small>
              </div>

              <form
                className="flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = new FormData(event.currentTarget);
                  const name = String(form.get("name") ?? "").trim();
                  if (!name || name === scope.name) return;
                  void updateScope(scope, { name }, "rename");
                }}
              >
                <input
                  key={`${scope.id}:${scope.name}`}
                  name="name"
                  defaultValue={scope.name}
                  aria-label="Context zone name"
                  className="min-w-0 flex-1 rounded border border-[#30363d] bg-[#010409] px-2 py-1 text-[11px] text-[#e6edf3]"
                />
                <button type="submit" disabled={scopeAction === `${scope.id}:rename`} className="rounded border border-cyan-500/30 px-2 py-1 text-[10px] text-cyan-300 disabled:opacity-50">
                  Save
                </button>
              </form>

              <div className="space-y-1">
                <span className="text-[10px] uppercase tracking-wide text-[#8b949e]">Members</span>
                {scope.memberNodeIds.length > 0 ? scope.memberNodeIds.map((nodeId) => (
                  <div key={nodeId} className="flex items-center justify-between gap-2 rounded bg-[#161b22] px-2 py-1">
                    <span className="truncate text-[11px] text-[#e6edf3]">{nodeLabels.get(nodeId) ?? "Unknown node"}</span>
                    <code className="text-[9px] text-[#6e7681]">{nodeId.slice(0, 8)}</code>
                  </div>
                )) : <span>No members yet</span>}
              </div>

              <div className="space-y-1">
                <span className="text-[10px] uppercase tracking-wide text-[#8b949e]">Context references</span>
                {scope.contextRefs.length > 0 ? scope.contextRefs.map((ref) => {
                  const key = `${ref.type}:${ref.id}`;
                  return (
                    <div key={key} className="flex items-center justify-between gap-2 rounded border border-[#30363d] bg-[#010409] px-2 py-1">
                      <code className="min-w-0 truncate text-[10px] text-cyan-200">{key}</code>
                      <button
                        type="button"
                        className="text-[10px] text-red-400 hover:text-red-300 disabled:opacity-50"
                        disabled={scopeAction === `${scope.id}:remove:${key}`}
                        onClick={() => void updateScope(scope, {
                          contextRefs: scope.contextRefs.filter((candidate) => candidate.type !== ref.type || candidate.id !== ref.id),
                        }, `remove:${key}`)}
                      >
                        Remove
                      </button>
                    </div>
                  );
                }) : <span className="text-[10px] text-[#8b949e]">No references attached yet.</span>}
              </div>

              <form
                className="grid grid-cols-[96px_1fr_auto] gap-1"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = new FormData(event.currentTarget);
                  const type = String(form.get("type") ?? "").trim();
                  const id = String(form.get("id") ?? "").trim();
                  if (!type || !id) return;
                  if (scope.contextRefs.some((ref) => ref.type === type && ref.id === id)) return;
                  void updateScope(scope, { contextRefs: [...scope.contextRefs, { type, id }] }, `add:${type}:${id}`);
                  event.currentTarget.reset();
                }}
              >
                <input name="type" placeholder="type" aria-label="Reference type" className="min-w-0 rounded border border-[#30363d] bg-[#010409] px-2 py-1 text-[10px] text-[#e6edf3]" />
                <input name="id" placeholder="reference id" aria-label="Reference id" className="min-w-0 rounded border border-[#30363d] bg-[#010409] px-2 py-1 text-[10px] text-[#e6edf3]" />
                <button type="submit" className="rounded border border-cyan-500/30 px-2 py-1 text-[10px] text-cyan-300">Add</button>
              </form>

              {scopeError && <span role="alert" className="block text-[10px] text-red-400">{scopeError}</span>}
              <small>Membership is persisted explicitly. Moving the outline does not redefine it.</small>
            </div>
          )}
        </div>
      ))}
      {draft && <div className="absolute border-2 border-dashed border-cyan-300 bg-cyan-400/10" style={{ left: draft.x, top: draft.y, width: draft.width, height: draft.height }} />}
      {drawing && <div className="absolute inset-0 pointer-events-auto cursor-crosshair" onPointerDown={begin} onPointerMove={move} onPointerUp={(e) => void finish(e)} />}
      {!drawing && <button className="pointer-events-auto absolute top-3 left-3 z-20 rounded-lg border border-cyan-500/30 bg-[#0d1117]/95 px-3 py-2 text-[11px] text-cyan-300 shadow-lg hover:bg-[#161b22]" onClick={() => setDrawing(true)}>＋ Shared Context</button>}
    </div>,
    host,
  );
}
