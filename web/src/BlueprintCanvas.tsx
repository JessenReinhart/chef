import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  ReactFlow,
  Background,
  MiniMap,
  Controls,
  Handle,
  Position,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type Connection,
  type OnNodesChange,
  type OnEdgesChange,
  type NodePositionChange,
  type NodeTypes,
  type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { catalogEntry, KIND_COLORS, STATUS_COLORS } from "./nodeCatalog";
import type { UiTask, NodeKind, NodeCatalogEntry, HarnessInfo, UiCanvasNode, UiCanvasEdge } from "./types";

export interface CanvasNodeData {
  label: string;
  status: string;
  kind: NodeKind;
  taskId: string;
  type: string;
  entry: NodeCatalogEntry | undefined;
  [key: string]: unknown;
}

const nodeDefaults = { type: "blueprint" } as const;

// Viewport (pan/zoom) stays in localStorage — it's a user preference, not
// authoritative runtime state. Position writes are REMOVED: positions now
// live in the runtime-owned canvas graph and are persisted via patchCanvas.
const VIEW_KEY = "chef:canvas:view";

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable — viewport just won't persist
  }
}

interface BlueprintCanvasProps {
  tasks: UiTask[];
  canvasNodes: UiCanvasNode[];
  canvasEdges: UiCanvasEdge[];
  onConnect: (source: string, target: string) => void;
  onDisconnect: (source: string, target: string) => void;
  onSelectNode: (task: UiTask | null) => void;
  onDropNode: (payload: { type: string; harnessId?: string }, position: { x: number; y: number }) => void;
  onNodeDragStop?: (id: string, position: { x: number; y: number }, label: string) => void;
  harnesses: HarnessInfo[];
}

function HarnessHandle({ color }: { color: string }) {
  return (
    <Handle
      type="target"
      position={Position.Left}
      style={{
        width: 12,
        height: 12,
        background: color,
        border: "2px solid #010409",
        boxShadow: `0 0 6px ${color}`,
        left: -6,
      }}
    />
  );
}

function HarnessHandleRight({ color }: { color: string }) {
  return (
    <Handle
      type="source"
      position={Position.Right}
      style={{
        width: 12,
        height: 12,
        background: color,
        border: "2px solid #010409",
        boxShadow: `0 0 6px ${color}`,
        right: -6,
      }}
    />
  );
}

const nodeTypes: NodeTypes = {
  blueprint: function BlueprintNode({ data, selected }: { data: CanvasNodeData; selected: boolean }) {
    const accent = data.entry ? (data.kind === "agent" ? "#06b6d4" : KIND_COLORS[data.kind] ?? "#6b7280") : KIND_COLORS[data.kind] ?? "#6b7280";
    const statusColor = STATUS_COLORS[data.status] ?? "#6b7280";
    const icon = data.entry?.icon ?? "◆";
    return (
      <div
        className={`relative min-w-[180px] max-w-[240px] rounded-xl border bg-[#0d1117]/95 text-left shadow-xl transition-all duration-200 ${
          selected ? "ring-2 ring-cyan-400/60 shadow-cyan-500/20" : "border-[#30363d]"
        }`}
        style={{ boxShadow: `0 0 0 1px ${accent}22, 0 6px 20px rgba(0,0,0,.55)` }}
      >
        <div
          className="flex items-center gap-2 rounded-t-xl border-b border-[#21262d] px-3 py-1.5"
          style={{ background: `${accent}1a` }}
        >
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: statusColor, boxShadow: data.status === "running" ? `0 0 6px ${statusColor}` : "none" }} />
          <span className="truncate text-[11px] font-semibold text-[#cbd5e1]" style={{ color: accent }}>
            {icon}
          </span>
          <span className="truncate text-[11px] font-semibold text-[#cbd5e1]">
            {data.entry?.label ?? data.label}
          </span>
        </div>
        <div className="px-3 py-2">
          <div className="truncate text-[13px] font-medium text-[#e6edf3]">{data.label}</div>
          <div className="mt-0.5 flex items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-wide" style={{ color: statusColor }}>
              {data.status}
            </span>
          </div>
        </div>
        <HarnessHandle color={accent} />
        <HarnessHandleRight color={accent} />
      </div>
    );
  },
};

export function BlueprintCanvas({
  tasks,
  canvasNodes,
  canvasEdges,
  onConnect,
  onDisconnect,
  onSelectNode,
  onDropNode,
  onNodeDragStop,
  harnesses,
}: BlueprintCanvasProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const flowRef = useRef<HTMLDivElement | null>(null);

  // Local React Flow state is the source of truth for canvas interactions (drag, zoom, connect).
  // Runtime `canvasNodes`/`canvasEdges` stay authoritative and are reconciled into this state below,
  // preserving whatever the user has dragged locally.
  const [rfNodes, setRfNodes] = useNodesState<Node<CanvasNodeData>>([]);
  const [rfEdges, setRfEdges] = useEdgesState<Edge>([]);

  // Status lookup keyed by node id (status comes from runtime tasks).
  const taskById = useMemo(() => {
    const map = new Map<string, UiTask>();
    for (const t of tasks) map.set(t.id, t);
    return map;
  }, [tasks]);

  // ── Reconcile runtime canvas nodes → canvas nodes (positions from server) ──
  useEffect(() => {
    setRfNodes((nds) => {
      const existing = new Map(nds.map((n) => [n.id, n]));
      let cascade = 0;
      const merged: Node<CanvasNodeData>[] = [];
      for (const node of canvasNodes) {
        const prev = existing.get(node.id);
        // Preserve a live in-progress drag position; otherwise use the server position.
        const position = prev?.position ?? node.position;
        const task = node.taskId ? taskById.get(node.taskId) : undefined;
        const status = task?.status ?? "pending";
        const entry = catalogEntry(node.nodeType === "blueprint" ? (node.kind === "agent" ? `harness.${node.harnessId ?? ""}` : node.label) : node.label)
          ?? catalogEntry(task?.workflowNodeId ?? node.id);
        merged.push({
          id: node.id,
          position,
          ...nodeDefaults,
          data: {
            label: node.label,
            status,
            kind: (entry?.kind ?? node.kind) as NodeKind,
            taskId: node.taskId ?? node.id,
            type: node.id,
            entry,
          },
        });
      }
      return merged;
    });
  }, [canvasNodes, taskById, setRfNodes]);

  // ── Reconcile runtime canvas edges ──
  useEffect(() => {
    setRfEdges(
      canvasEdges.map((e) => {
        const sourceTask = e.source ? taskById.get(e.source) : undefined;
        const isRunning =
          sourceTask && (sourceTask.status === "running" || sourceTask.status === "spawning" || sourceTask.status === "assigned");
        return {
          id: `${e.source}->${e.target}`,
          source: e.source,
          target: e.target,
          type: "smoothstep",
          style: { stroke: isRunning ? "#06b6d4" : "#58a6ff", strokeWidth: isRunning ? 3 : 2 },
          animated: isRunning,
          markerEnd: { type: "arrowclosed", color: isRunning ? "#06b6d4" : "#58a6ff" },
        };
      }),
    );
  }, [canvasEdges, taskById, setRfEdges]);

  // Track selected node so the parent can show the toolbar
  const handleNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      const data = node.data as CanvasNodeData;
      onSelectNode(taskById.get(data.taskId) ?? null);
    },
    [taskById, onSelectNode],
  );

  const handlePaneClick = useCallback(() => {
    onSelectNode(null);
  }, [onSelectNode]);

  // Node drag: apply to React Flow state only. Persisted on drag-stop (debounced).
  const onNodesChange: OnNodesChange<Node<CanvasNodeData>> = useCallback(
    (changes) => {
      setRfNodes((nds) => applyNodeChanges(changes, nds));
    },
    [setRfNodes],
  );

  // Edge removal (select + Delete): tell the runtime, then apply locally
  const onEdgesChange: OnEdgesChange = useCallback(
    (changes) => {
      for (const c of changes) {
        if (c.type === "remove") {
          const [source, target] = c.id.split("->");
          if (source && target) onDisconnect(source, target);
        }
      }
      setRfEdges((eds) => applyEdgeChanges(changes, eds));
    },
    [setRfEdges, onDisconnect],
  );

  // Optimistic connect (same as React Flow's addEdge) so the line renders instantly.
  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target || connection.source === connection.target) return;
      setRfEdges((eds) =>
        addEdge(
          {
            id: `${connection.source}->${connection.target}`,
            source: connection.source,
            target: connection.target,
            type: "smoothstep",
            style: { stroke: "#58a6ff", strokeWidth: 2 },
          },
          eds,
        ),
      );
      onConnect(connection.source, connection.target);
    },
    [setRfEdges, onConnect],
  );

  // Persist drag-end position via patchCanvas (debounced 500ms to coalesce).
  const dragStopTimer = useRef<number | null>(null);
  const handleNodeDragStop = useCallback(
    (_event: MouseEvent | TouchEvent, node: Node) => {
      if (!onNodeDragStop) return;
      if (dragStopTimer.current) window.clearTimeout(dragStopTimer.current);
      const id = node.id;
      const position = node.position;
      const data = node.data as CanvasNodeData;
      const label = data.label;
      dragStopTimer.current = window.setTimeout(() => {
        void onNodeDragStop(id, position, label);
      }, 500);
    },
    [onNodeDragStop],
  );

  // ── Drag-and-drop from the node palette ──
  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const raw = event.dataTransfer.getData("application/chef-node");
      if (!raw || !flowRef.current) return;
      let payload: { type: string; harnessId?: string };
      try {
        payload = JSON.parse(raw) as { type: string; harnessId?: string };
      } catch {
        payload = { type: raw };
      }
      const bounds = flowRef.current.getBoundingClientRect();
      const position = {
        x: event.clientX - bounds.left - 90,
        y: event.clientY - bounds.top - 30,
      };
      onDropNode(payload, position);
    },
    [onDropNode],
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  // Restore the saved viewport on mount instead of mutating the DOM transform,
  // so React Flow's internal (d3-zoom) viewport stays consistent with what's rendered.
  const defaultViewport = useMemo(
    () => loadJson<{ x: number; y: number; zoom: number } | null>(VIEW_KEY, null) ?? undefined,
    [],
  );

  return (
    <div ref={wrapperRef} className="relative h-full w-full bg-[#010409]" onDrop={onDrop} onDragOver={onDragOver}>
      <div ref={flowRef} className="h-full w-full">
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={handleConnect}
          onNodeClick={handleNodeClick}
          onPaneClick={handlePaneClick}
          onNodeDragStop={handleNodeDragStop}
          onMoveEnd={(_event, viewport) => saveJson(VIEW_KEY, viewport)}
          defaultViewport={defaultViewport}
          fitView={!defaultViewport}
          fitViewOptions={{ padding: 0.2, maxZoom: 1.2 }}
          minZoom={0.2}
          maxZoom={2.5}
          defaultEdgeOptions={{ type: "smoothstep", style: { stroke: "#58a6ff", strokeWidth: 2 } }}
          connectionLineStyle={{ stroke: "#58a6ff", strokeWidth: 2 }}
          connectionRadius={12}
          panOnDrag
          zoomOnScroll
          zoomOnPinch
          className="!bg-[#010409]"
        >
          <Background gap={24} size={1} color="#161b22" />
          <MiniMap
            position="bottom-right"
            nodeColor={(n) => {
              const data = n.data as CanvasNodeData;
              return data.entry ? (data.kind === "agent" ? "#06b6d4" : KIND_COLORS[data.kind]) : KIND_COLORS[data.kind] ?? "#6b7280";
            }}
            className="!bg-[#0d1117] !border !border-[#30363d]"
          />
          <Controls position="bottom-left" className="!bg-[#0d1117] !border !border-[#30363d]" />
        </ReactFlow>
      </div>
    </div>
  );
}
