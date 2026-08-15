import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  ReactFlow,
  Background,
  MiniMap,
  Controls,
  Handle,
  Position,
  type Node,
  type Edge,
  type Connection,
  type OnNodesChange,
  type OnEdgesChange,
  type NodeTypes,
  type NodeMouseHandler,
} from "@xyflow/react";
import { catalogEntry, KIND_COLORS, STATUS_COLORS } from "./nodeCatalog";
import type { UiTask, NodeKind, NodeCatalogEntry, HarnessInfo } from "./types";

export interface CanvasNodeData {
  label: string;
  status: string;
  kind: NodeKind;
  taskId: string;
  type: string;
  entry: NodeCatalogEntry | undefined;
  [key: string]: unknown;
}

const nodeDefaults = {
  type: "blueprint",
  sourcePosition: "right" as const,
  targetPosition: "left" as const,
};

const POSITIONS_KEY = "chef:canvas:positions";
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
    // storage unavailable — positions just won't persist
  }
}

interface BlueprintCanvasProps {
  tasks: UiTask[];
  dependencies: Array<{ source: string; target: string }>;
  onConnect: (source: string, target: string) => void;
  onDisconnect: (source: string, target: string) => void;
  onSelectNode: (task: UiTask | null) => void;
  onDropNode: (payload: { type: string; harnessId?: string }, position: { x: number; y: number }) => void;
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
        className={`min-w-[180px] max-w-[240px] rounded-xl border bg-[#0d1117]/95 text-left shadow-xl transition-all duration-200 ${
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

export function BlueprintCanvas({ tasks, dependencies, onConnect, onDisconnect, onSelectNode, onDropNode, harnesses }: BlueprintCanvasProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const flowRef = useRef<HTMLDivElement | null>(null);

  // ── Derive React Flow nodes from runtime tasks, preserving local drag positions ──
  const nodes: Node<CanvasNodeData>[] = useMemo(() => {
    const savedPositions = loadJson<Record<string, { x: number; y: number }>>(POSITIONS_KEY, {});
    let cascade = 0;
    return tasks.map((task, index) => {
      const saved = savedPositions[task.id];
      const position = saved ?? { x: 100 + (index % 4) * 320, y: 80 + Math.floor(index / 4) * 200 + cascade * 12 };
      if (!saved) cascade++;
      const entry = catalogEntry(task.workflowNodeId ?? task.id) ?? catalogEntry(`harness.${task.assignedTo ?? ""}`);
      return {
        id: task.id,
        position,
        ...nodeDefaults,
        data: {
          label: task.title,
          status: task.status,
          kind: entry?.kind ?? (task.assignedTo ? "agent" : "tool"),
          taskId: task.id,
          type: task.workflowNodeId ?? task.id,
          entry,
        },
      } as Node<CanvasNodeData>;
    });
  }, [tasks, harnesses]);

  // ── Edges from runtime dependencies, animated when source is running ──
  const edges: Edge[] = useMemo(
    () =>
      dependencies.map((d) => {
        const sourceTask = tasks.find((t) => t.id === d.source);
        const isRunning = sourceTask && (sourceTask.status === "running" || sourceTask.status === "spawning" || sourceTask.status === "assigned");
        return {
          id: `${d.source}->${d.target}`,
          source: d.source,
          target: d.target,
          type: "smoothstep",
          style: { stroke: isRunning ? "#06b6d4" : "#58a6ff", strokeWidth: isRunning ? 3 : 2 },
          animated: isRunning,
          markerEnd: { type: "arrowclosed", color: isRunning ? "#06b6d4" : "#58a6ff" },
        } as Edge;
      }),
    [dependencies, tasks],
  );

  // Track selected node for toolbar (parent renders toolbar over canvas)
  const handleNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      const data = node.data as CanvasNodeData;
      const task = tasks.find((t) => t.id === data.taskId) ?? null;
      onSelectNode(task);
    },
    [tasks, onSelectNode],
  );

  const handlePaneClick = useCallback(() => {
    onSelectNode(null);
  }, [onSelectNode]);

  // Persist drag positions
  const onNodesChange: OnNodesChange = useCallback((changes) => {
    const positionChanges = changes.filter((c) => c.type === "position" && c.position);
    if (positionChanges.length === 0) return;
    const positions = loadJson<Record<string, { x: number; y: number }>>(POSITIONS_KEY, {});
    for (const change of positionChanges) {
      if (change.type === "position" && change.id && change.position) {
        positions[change.id] = { x: change.position.x, y: change.position.y };
      }
    }
    saveJson(POSITIONS_KEY, positions);
  }, []);

  const onEdgesChange: OnEdgesChange = useCallback(
    (changes) => {
      const removals = changes.filter((c) => c.type === "remove");
      for (const removal of removals) {
        const [source, target] = removal.id.split("->");
        if (source && target) onDisconnect(source, target);
      }
    },
    [onDisconnect],
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      if (connection.source === connection.target) return;
      onConnect(connection.source, connection.target);
    },
    [onConnect],
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

  // Restore viewport on first load
  useEffect(() => {
    const savedView = loadJson<{ x: number; y: number; zoom: number } | null>(VIEW_KEY, null);
    if (savedView) {
      const el = wrapperRef.current;
      if (el) {
        const viewport = el.querySelector(".react-flow__viewport") as HTMLElement | null;
        if (viewport) {
          viewport.style.transform = `translate(${savedView.x}px, ${savedView.y}px) scale(${savedView.zoom})`;
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={wrapperRef} className="relative h-full w-full bg-[#010409]" onDrop={onDrop} onDragOver={onDragOver}>
      <div ref={flowRef} className="h-full w-full">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={handleConnect}
          onNodeClick={handleNodeClick}
          onPaneClick={handlePaneClick}
          onMoveEnd={(_event, viewport) => saveJson(VIEW_KEY, viewport)}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1.2 }}
          minZoom={0.2}
          maxZoom={2.5}
          defaultEdgeOptions={{ type: "smoothstep", style: { stroke: "#58a6ff", strokeWidth: 2 } }}
          connectionLineStyle={{ stroke: "#58a6ff", strokeWidth: 2 }}
          connectionRadius={6}
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
