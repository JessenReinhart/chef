import { useEffect, useState } from "react";
import type { WorkflowGraph, GraphNode, GraphEdge } from "../../src/core/graph.ts";

interface CanvasPanelProps {
  /** Bumped by the parent poll loop; refetches the projection. */
  refreshTick: number;
}

const NODE_W = 150;
const NODE_H = 44;

function nodeColor(node: GraphNode): string {
  if (node.kind === "human" && node.type === "approval") return "#9e6a03";
  if (node.status === "running") return "#238636";
  if (node.status === "failed" || node.status === "cancelled") return "#da3633";
  if (node.status === "blocked") return "#9e6a03";
  if (node.status === "completed") return "#1f6feb";
  return "#30363d";
}

function edgeColor(edge: GraphEdge): string {
  if (edge.kind === "approval") return "#9e6a03";
  if (edge.kind === "data") return "#1f6feb";
  return "#6e7681";
}

export function CanvasPanel({ refreshTick }: CanvasPanelProps) {
  const [graph, setGraph] = useState<WorkflowGraph | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/graph");
      if (res.ok) setGraph((await res.json()) as WorkflowGraph);
    })();
  }, [refreshTick]);

  if (!graph || graph.nodes.length === 0) {
    return <div style={{ color: "#8b949e", fontSize: 13 }}>No plan graph yet.</div>;
  }

  const minX = Math.min(...graph.nodes.map((n) => n.position.x));
  const minY = Math.min(...graph.nodes.map((n) => n.position.y));
  const maxX = Math.max(...graph.nodes.map((n) => n.position.x + NODE_W));
  const maxY = Math.max(...graph.nodes.map((n) => n.position.y + NODE_H));
  const pad = 30;

  const resolveApproval = async (node: GraphNode, decision: "accept" | "reject") => {
    const approvalId = node.config.approvalId as string | undefined;
    if (!approvalId) return;
    await fetch(`/api/approvals/${approvalId}/${decision}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approver: "dashboard" }),
    });
  };

  return (
    <div style={{ overflow: "auto", border: "1px solid #30363d", borderRadius: 8, background: "#0d1117" }}>
      <svg width={maxX - minX + pad * 2} height={maxY - minY + pad * 2} style={{ display: "block" }}>
        <g transform={`translate(${pad - minX}, ${pad - minY})`}>
          {graph.edges.map((edge) => {
            const source = graph.nodes.find((n) => n.id === edge.source);
            const target = graph.nodes.find((n) => n.id === edge.target);
            if (!source || !target) return null;
            const x1 = source.position.x + NODE_W / 2;
            const y1 = source.position.y + NODE_H;
            const x2 = target.position.x + NODE_W / 2;
            const y2 = target.position.y;
            const mid = (y1 + y2) / 2;
            return (
              <path
                key={edge.id}
                d={`M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`}
                fill="none"
                stroke={edgeColor(edge)}
                strokeWidth={1.5}
                strokeDasharray={edge.kind === "approval" ? "5 3" : undefined}
              />
            );
          })}
          {graph.nodes.map((node) => {
            const fill = nodeColor(node);
            const isApproval = node.kind === "human" && node.type === "approval";
            return (
              <g key={node.id} transform={`translate(${node.position.x}, ${node.position.y})`}>
                <rect width={NODE_W} height={NODE_H} rx={8} fill={fill} stroke="#8b949e" strokeWidth={1} />
                <text x={NODE_W / 2} y={18} textAnchor="middle" fill="#e6edf3" fontSize={12} fontWeight={700}>
                  {isApproval ? "APPROVAL" : (node.config.title as string | undefined) ?? node.id.slice(0, 10)}
                </text>
                <text x={NODE_W / 2} y={34} textAnchor="middle" fill="#c9d1d9" fontSize={10}>
                  {node.status ?? node.kind}
                </text>
                {isApproval && (
                  <>
                    <rect x={8} y={52} width={60} height={22} rx={4} fill="#238636" onClick={() => void resolveApproval(node, "accept")} style={{ cursor: "pointer" }} />
                    <text x={38} y={67} textAnchor="middle" fill="#fff" fontSize={11}>Accept</text>
                    <rect x={78} y={52} width={60} height={22} rx={4} fill="#da3633" onClick={() => void resolveApproval(node, "reject")} style={{ cursor: "pointer" }} />
                    <text x={108} y={67} textAnchor="middle" fill="#fff" fontSize={11}>Reject</text>
                  </>
                )}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
