import { useEffect, useRef, useState } from "react";
import type { WorkflowGraph, GraphNode, GraphEdge } from "../../src/core/graph.ts";

interface CanvasPanelProps {
  /** Bumped by the parent poll loop; refetches the projection. */
  refreshTick: number;
  /** Raised when a node is clicked/selected on the canvas. */
  onSelectNode: (node: GraphNode | null) => void;
  /** Raised when a library node is dropped onto the canvas. */
  onDropNode: (type: string, position: { x: number; y: number }) => void;
}

const NODE_W = 150;
const NODE_H = 44;
const MIN_SCALE = 0.3;
const MAX_SCALE = 2.5;

function nodeColor(node: GraphNode): string {
  if (node.kind === "human" && node.type === "approval") return "#9e6a03";
  if (node.status === "running") return "#238636";
  if (node.status === "failed" || node.status === "cancelled") return "#da3633";
  if (node.status === "blocked") return "#9e6a03";
  if (node.status === "completed") return "#1f6feb";
  return "#30363d";
}

const EDGE_VISUALS: Record<GraphEdge["kind"], { color: string; dash?: string; label: string }> = {
  data: { color: "#1f6feb", label: "data" },
  control: { color: "#6e7681", label: "dependency" },
  conditional: { color: "#a371f7", dash: "8 4", label: "condition" },
  error: { color: "#da3633", dash: "3 3", label: "error" },
  approval: { color: "#9e6a03", dash: "5 3", label: "approval" },
};

function edgeVisual(edge: GraphEdge) {
  return EDGE_VISUALS[edge.kind];
}

export function CanvasPanel({ refreshTick, onSelectNode, onDropNode }: CanvasPanelProps) {
  const [graph, setGraph] = useState<WorkflowGraph | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragState = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/graph");
      if (res.ok) setGraph((await res.json()) as WorkflowGraph);
    })();
  }, [refreshTick]);

  // Keep the selected node reference fresh across refreshes: selection is
  // by id, so a node that disappears (graph change) deselects itself.
  useEffect(() => {
    if (selectedId && !graph?.nodes.some((n) => n.id === selectedId)) {
      setSelectedId(null);
      onSelectNode(null);
    }
  }, [graph, selectedId, onSelectNode]);

  if (!graph || graph.nodes.length === 0) {
    return (
      <div className="wb-canvas__viewport" ref={viewportRef}>
        <div style={{ color: "var(--fg-secondary)", fontSize: 13, padding: 16 }}>No plan graph yet.</div>
      </div>
    );
  }

  const minX = Math.min(...graph.nodes.map((n) => n.position.x));
  const minY = Math.min(...graph.nodes.map((n) => n.position.y));
  const maxX = Math.max(...graph.nodes.map((n) => n.position.x + NODE_W));
  const maxY = Math.max(...graph.nodes.map((n) => n.position.y + NODE_H));
  const pad = 30;
  const contentW = maxX - minX + pad * 2;
  const contentH = maxY - minY + pad * 2;

  const viewport = viewportRef.current;
  const viewW = viewport?.clientWidth ?? 800;
  const viewH = viewport?.clientHeight ?? 600;
  const fitScale = Math.max(MIN_SCALE, Math.min(1, Math.min(viewW / contentW, viewH / contentH)));
  // Start each refresh with a fitted view unless the user has interacted.
  const effectiveScale = dragState.current ? scale : fitScale;
  const offsetX = pan.x + (viewW - contentW * effectiveScale) / 2;
  const offsetY = pan.y + (viewH - contentH * effectiveScale) / 2;

  const onWheel = (event: React.WheelEvent) => {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale - event.deltaY * 0.0015));
      setScale(next);
    }
  };

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    dragState.current = { startX: event.clientX, startY: event.clientY, panX: pan.x, panY: pan.y };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    if (!dragState.current) return;
    setPan({
      x: dragState.current.panX + (event.clientX - dragState.current.startX),
      y: dragState.current.panY + (event.clientY - dragState.current.startY),
    });
  };

  const onPointerUp = (event: React.PointerEvent) => {
    dragState.current = null;
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
  };

  const onWheelScale = (factor: number) => {
    setScale((current) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, current * factor)));
  };

  const handleNodeClick = (node: GraphNode) => {
    if (dragState.current) return; // was a pan drag, not a click
    setSelectedId(node.id);
    onSelectNode(node);
  };

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    const type = event.dataTransfer.getData("text/chef-node-type");
    if (!type) return;
    const svg = event.currentTarget.querySelector("svg");
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const x = (event.clientX - rect.left - offsetX) / effectiveScale;
    const y = (event.clientY - rect.top - offsetY) / effectiveScale;
    onDropNode(type, { x, y });
  };

  const selectedNode = graph.nodes.find((n) => n.id === selectedId) ?? null;

  return (
    <div className="wb-canvas__viewport" ref={viewportRef} onDrop={handleDrop} onDragOver={(event) => event.preventDefault()}>
      <svg
        className="wb-canvas__svg"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <defs>
          {(Object.entries(EDGE_VISUALS) as Array<[GraphEdge["kind"], (typeof EDGE_VISUALS)[GraphEdge["kind"]]]>).map(([kind, visual]) => (
            <marker
              key={kind}
              id={`chef-edge-arrow-${kind}`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill={visual.color} />
            </marker>
          ))}
        </defs>
        <g transform={`translate(${offsetX}, ${offsetY}) scale(${effectiveScale})`}>
          <g transform={`translate(${-minX + pad}, ${-minY + pad})`}>
            {graph.edges.map((edge) => {
              const source = graph.nodes.find((n) => n.id === edge.source);
              const target = graph.nodes.find((n) => n.id === edge.target);
              if (!source || !target) return null;
              const x1 = source.position.x + NODE_W / 2;
              const y1 = source.position.y + NODE_H;
              const x2 = target.position.x + NODE_W / 2;
              const y2 = target.position.y;
              const mid = (y1 + y2) / 2;
              const labelX = (x1 + x2) / 2;
              const labelY = mid;
              const visual = edgeVisual(edge);
              const labelWidth = Math.max(42, visual.label.length * 6.5 + 14);
              return (
                <g key={edge.id} className={`wb-canvas__edge wb-canvas__edge--${edge.kind}`}>
                  <path
                    d={`M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`}
                    fill="none"
                    stroke={visual.color}
                    strokeWidth={1.75}
                    strokeDasharray={visual.dash}
                    markerEnd={`url(#chef-edge-arrow-${edge.kind})`}
                  />
                  <rect
                    x={labelX - labelWidth / 2}
                    y={labelY - 9}
                    width={labelWidth}
                    height={18}
                    rx={9}
                    fill="var(--bg-primary)"
                    stroke={visual.color}
                    strokeWidth={0.75}
                    opacity={0.96}
                    pointerEvents="none"
                  />
                  <text
                    x={labelX}
                    y={labelY + 3.5}
                    textAnchor="middle"
                    fill={visual.color}
                    fontSize={9}
                    fontWeight={700}
                    letterSpacing={0.2}
                    pointerEvents="none"
                  >
                    {visual.label}
                  </text>
                </g>
              );
            })}
            {graph.nodes.map((node) => {
              const fill = nodeColor(node);
              const isApproval = node.kind === "human" && node.type === "approval";
              const isSelected = node.id === selectedId;
              return (
                <g
                  key={node.id}
                  className={`wb-canvas__node${isSelected ? " wb-canvas__node--selected" : ""}`}
                  transform={`translate(${node.position.x}, ${node.position.y})`}
                  onClick={() => handleNodeClick(node)}
                >
                  <rect width={NODE_W} height={NODE_H} rx={8} fill={fill} stroke="#8b949e" strokeWidth={1} />
                  <text x={NODE_W / 2} y={18} textAnchor="middle" fill="#e6edf3" fontSize={12} fontWeight={700}>
                    {isApproval ? "APPROVAL" : (node.config.title as string | undefined) ?? node.id.slice(0, 10)}
                  </text>
                  <text x={NODE_W / 2} y={34} textAnchor="middle" fill="#c9d1d9" fontSize={10}>
                    {node.status ?? node.kind}
                  </text>
                  {isApproval && (
                    <>
                      <rect
                        x={8}
                        y={52}
                        width={60}
                        height={22}
                        rx={4}
                        fill="#238636"
                        onClick={(e) => {
                          e.stopPropagation();
                          void resolveApproval(node, "accept");
                        }}
                        style={{ cursor: "pointer" }}
                      />
                      <text x={38} y={67} textAnchor="middle" fill="#fff" fontSize={11}>
                        Accept
                      </text>
                      <rect
                        x={78}
                        y={52}
                        width={60}
                        height={22}
                        rx={4}
                        fill="#da3633"
                        onClick={(e) => {
                          e.stopPropagation();
                          void resolveApproval(node, "reject");
                        }}
                        style={{ cursor: "pointer" }}
                      />
                      <text x={108} y={67} textAnchor="middle" fill="#fff" fontSize={11}>
                        Reject
                      </text>
                    </>
                  )}
                </g>
              );
            })}
          </g>
        </g>
      </svg>

      <div className="wb-canvas__controls" style={{ position: "absolute", bottom: 12, left: 12, display: "flex", gap: 6, zIndex: 10 }}>
        <button className="wb-btn wb-btn--secondary" onClick={() => onWheelScale(1 / 1.2)} aria-label="Zoom out" title="Zoom out">
          −
        </button>
        <button className="wb-btn wb-btn--secondary" onClick={() => onWheelScale(1.2)} aria-label="Zoom in" title="Zoom in">
          +
        </button>
        <button
          className="wb-btn wb-btn--secondary"
          onClick={() => {
            setScale(1);
            setPan({ x: 0, y: 0 });
          }}
          title="Reset view"
        >
          Fit
        </button>
        <span
          className="wb-btn wb-btn--secondary"
          style={{ cursor: "default", fontSize: 12, padding: "6px 10px" }}
          title="Current zoom"
        >
          {Math.round(effectiveScale * 100)}%
        </span>
      </div>

      {graph.nodes.length > 0 && (
        <div className="wb-canvas__minimap" aria-hidden>
          <svg viewBox={`${minX - 10} ${minY - 10} ${maxX - minX + 20} ${maxY - minY + 20}`} preserveAspectRatio="xMidYMid meet">
            {graph.edges.map((edge) => {
              const source = graph.nodes.find((n) => n.id === edge.source);
              const target = graph.nodes.find((n) => n.id === edge.target);
              if (!source || !target) return null;
              const visual = edgeVisual(edge);
              return (
                <line
                  key={edge.id}
                  x1={source.position.x + NODE_W / 2}
                  y1={source.position.y + NODE_H / 2}
                  x2={target.position.x + NODE_W / 2}
                  y2={target.position.y + NODE_H / 2}
                  stroke={visual.color}
                  strokeWidth={1}
                  strokeDasharray={visual.dash}
                />
              );
            })}
            {graph.nodes.map((node) => (
              <rect
                key={node.id}
                x={node.position.x}
                y={node.position.y}
                width={NODE_W}
                height={NODE_H}
                rx={4}
                fill={nodeColor(node)}
                opacity={0.85}
              />
            ))}
          </svg>
        </div>
      )}
      {selectedNode && (
        <div style={{ position: "absolute", top: 12, left: 12, fontSize: 12, color: "var(--fg-secondary)", zIndex: 10 }}>
          Selected: <strong style={{ color: "var(--fg-primary)" }}>{(selectedNode.config.title as string | undefined) ?? selectedNode.id}</strong>
        </div>
      )}
    </div>
  );

  async function resolveApproval(node: GraphNode, decision: "accept" | "reject") {
    const approvalId = node.config.approvalId as string | undefined;
    if (!approvalId) return;
    await fetch(`/api/approvals/${approvalId}/${decision}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approver: "dashboard" }),
    });
  }
}
