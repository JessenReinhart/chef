import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { api } from "./api";
import { loadSelectedThreadId, SELECTED_THREAD_EVENT, threadMessages } from "./threadApi";
import {
  createThreadHistoryLoader,
  setThreadSubmissionPending,
  threadSubmissionKey,
} from "./threadSelection";
import { missionSubmissionAcknowledgement } from "./missionSubmissionFeedback";
import type {
  HarnessInfo,
  MissionStatus,
  UiCanvasEdge,
  UiCanvasNode,
  UiMission,
  UiTask,
} from "./types";
import "./living-workspace.css";

type Approval = { id: string; reason: string; taskId: string; status: string };

type WorkspaceSnapshot = {
  tasks: UiTask[];
  nodes: UiCanvasNode[];
  edges: UiCanvasEdge[];
  missions: UiMission[];
  approvals: Approval[];
};

type LivingNodeData = {
  label: string;
  status: string;
  icon: string;
  kind: UiCanvasNode["kind"];
  harnessId: string | null;
  missionMember: boolean;
};

type MissionNodeData = {
  goal: string;
  status: MissionStatus;
  completed: number;
  total: number;
};

type Side = "left" | "right" | "top" | "bottom";

type RoutedHandles = {
  sourceHandle: string;
  targetHandle: string;
};

const EMPTY_SNAPSHOT: WorkspaceSnapshot = {
  tasks: [],
  nodes: [],
  edges: [],
  missions: [],
  approvals: [],
};

const DEFAULT_CHEF_NOTE = "Tell me what you want done. I'll shape the workspace around it.";

const QUICK_PROMPTS = [
  "Prepare this month's report and flag anything unusual",
  "Investigate and fix this bug",
  "Research the options and recommend the best one",
];

const WORKING_TASK_STATES = new Set(["assigned", "spawning", "running"]);
const SIDES: Array<{ side: Side; position: Position }> = [
  { side: "left", position: Position.Left },
  { side: "right", position: Position.Right },
  { side: "top", position: Position.Top },
  { side: "bottom", position: Position.Bottom },
];

function taskStatus(task: UiTask | undefined, node: UiCanvasNode): string {
  // A task is the durable execution truth. Canvas liveStatus describes the
  // attached surface/session and can legitimately remain `offline` after the
  // task has moved to pending/completed. Prefer task state for task-backed
  // nodes so the living projection does not contradict itself.
  if (task) {
    const labels: Record<string, string> = {
      pending: "idle",
      assigned: "starting",
      spawning: "starting",
      running: "working",
      completed: "ready",
      failed: "failed",
      blocked: "blocked",
      cancelled: "offline",
    };
    return labels[task.status] ?? task.status;
  }
  return node.liveStatus ?? "idle";
}

function friendlyStatus(status: string): string {
  const labels: Record<string, string> = {
    idle: "Ready",
    offline: "Offline",
    starting: "Getting ready",
    working: "Working",
    waiting: "Waiting",
    needs_input: "Needs you",
    blocked: "Blocked",
    failed: "Needs attention",
    ready: "Done",
    completed: "Done",
    planning: "Putting a plan together",
    active: "Chef is working",
    paused: "Paused",
    waiting_for_approval: "Needs your approval",
    verifying: "Checking the result",
    cancelled: "Stopped",
  };
  return labels[status] ?? status.replaceAll("_", " ");
}

function missionStatusFor(snapshot: WorkspaceSnapshot): MissionStatus {
  if (snapshot.approvals.length > 0) return "waiting_for_approval";
  if (snapshot.tasks.some((task) => task.status === "blocked")) return "blocked";
  if (snapshot.tasks.some((task) => WORKING_TASK_STATES.has(task.status))) return "active";
  if (snapshot.tasks.length > 0 && snapshot.tasks.every((task) => task.status === "completed")) return "completed";
  if (snapshot.tasks.some((task) => task.status === "failed")) return "failed";
  if (snapshot.tasks.some((task) => task.status === "pending")) return "planning";
  return "idle";
}

function nodeIcon(node: UiCanvasNode, task?: UiTask): string {
  const type = task?.workflowNodeId ?? "";
  if (node.kind === "agent") return "✦";
  if (node.kind === "approval") return "✓";
  if (node.kind === "data") return "▤";
  if (node.kind === "system") return "✺";
  if (type.includes("browser")) return "◎";
  if (type.includes("terminal")) return ">_";
  if (type.includes("file")) return "▤";
  return "◇";
}

function NodeHandles({ target = true, source = true }: { target?: boolean; source?: boolean }) {
  return (
    <>
      {SIDES.map(({ side, position }) => (
        <span key={side}>
          {target && <Handle className="chef-living-handle" id={`target-${side}`} type="target" position={position} />}
          {source && <Handle className="chef-living-handle" id={`source-${side}`} type="source" position={position} />}
        </span>
      ))}
    </>
  );
}

function LivingObjectNode({ data, selected }: NodeProps) {
  const item = data as LivingNodeData;
  const active = item.status === "working" || item.status === "starting";
  return (
    <div
      className={`chef-living-node ${selected ? "is-selected" : ""} ${active ? "is-active" : ""}`}
      data-status={item.status}
    >
      <NodeHandles />
      <div className="chef-living-node__orb" aria-hidden="true">
        <span>{item.icon}</span>
      </div>
      <strong>{item.label}</strong>
      <span className="chef-living-node__status">
        <i />
        {friendlyStatus(item.status)}
      </span>
    </div>
  );
}

function MissionFocusNode({ data }: NodeProps) {
  const item = data as MissionNodeData;
  const progress = item.total === 0 ? 6 : Math.max(6, Math.round((item.completed / item.total) * 100));
  return (
    <div className="chef-mission-focus" data-status={item.status}>
      <NodeHandles target={false} />
      <span className="chef-mission-focus__eyebrow">Your work</span>
      <strong>{item.goal}</strong>
      <div className="chef-mission-focus__meta">
        <span className="chef-mission-focus__status"><i />{friendlyStatus(item.status)}</span>
        {item.total > 0 && <span>{item.completed}/{item.total} ready</span>}
      </div>
      <div className="chef-mission-focus__track" aria-label={`${progress}% complete`}>
        <span style={{ width: `${progress}%` }} />
      </div>
    </div>
  );
}

const NODE_TYPES = {
  living: LivingObjectNode,
  mission: MissionFocusNode,
} as NodeTypes;

function semanticPosition(index: number, total: number): { x: number; y: number } {
  const innerCount = Math.min(total, 8);
  const outer = index >= innerCount;
  const ringIndex = outer ? index - innerCount : index;
  const ringCount = outer ? Math.max(1, total - innerCount) : Math.max(1, innerCount);
  const radiusX = outer ? 520 : 340;
  const radiusY = outer ? 340 : 225;
  const angle = -Math.PI / 2 + (ringIndex / ringCount) * Math.PI * 2;
  return {
    x: Math.cos(angle) * radiusX - 74,
    y: Math.sin(angle) * radiusY - 42,
  };
}

function nodeProjectionScore(node: UiCanvasNode): number {
  return (node.nodeType === "blueprint" ? 4 : 0)
    + (node.harnessId ? 2 : 0)
    + (node.liveStatus && node.liveStatus !== "offline" ? 1 : 0);
}

function isWorkspaceHelper(node: UiCanvasNode, task?: UiTask): boolean {
  if (!node.taskId) return true;
  const type = task?.workflowNodeId ?? "";
  return type.startsWith("harness.") || type.startsWith("tool.");
}

function centerOf(node: Node): { x: number; y: number } {
  if (node.type === "mission") {
    return { x: node.position.x + 155, y: node.position.y + 88 };
  }
  return { x: node.position.x + 74, y: node.position.y + 48 };
}

function routeHandles(source: Node | undefined, target: Node | undefined): RoutedHandles {
  if (!source || !target) {
    return { sourceHandle: "source-right", targetHandle: "target-left" };
  }
  const a = centerOf(source);
  const b = centerOf(target);
  const dx = b.x - a.x;
  const dy = b.y - a.y;

  if (Math.abs(dx) >= Math.abs(dy)) {
    const sourceSide: Side = dx >= 0 ? "right" : "left";
    const targetSide: Side = dx >= 0 ? "left" : "right";
    return { sourceHandle: `source-${sourceSide}`, targetHandle: `target-${targetSide}` };
  }

  const sourceSide: Side = dy >= 0 ? "bottom" : "top";
  const targetSide: Side = dy >= 0 ? "top" : "bottom";
  return { sourceHandle: `source-${sourceSide}`, targetHandle: `target-${targetSide}` };
}

export function LivingWorkspaceFeature() {
  const [enabled, setEnabled] = useState(() => localStorage.getItem("chef:view-mode") !== "power");
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>(EMPTY_SNAPSHOT);
  const [harnesses, setHarnesses] = useState<HarnessInfo[]>([]);
  const [projectName, setProjectName] = useState("Workspace");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [optimisticGoal, setOptimisticGoal] = useState("");
  const [chefNote, setChefNote] = useState(DEFAULT_CHEF_NOTE);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(() => loadSelectedThreadId());
  const [submittingThreadKeys, setSubmittingThreadKeys] = useState<Set<string>>(() => new Set());
  const [toolsOpen, setToolsOpen] = useState(false);
  const [directMessage, setDirectMessage] = useState("");
  const [directSending, setDirectSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const threadHistoryLoader = useMemo(() => createThreadHistoryLoader(threadMessages), []);
  const sending = submittingThreadKeys.has(threadSubmissionKey(selectedThreadId));

  useEffect(() => {
    const timer = window.setInterval(() => {
      setEnabled(localStorage.getItem("chef:view-mode") !== "power");
    }, 250);
    return () => window.clearInterval(timer);
  }, []);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const state = await api.stateRaw();
      setSnapshot({
        tasks: state.tasks,
        nodes: state.canvasNodes,
        edges: state.canvasEdges,
        missions: state.missions ?? [],
        approvals: state.approvals.filter((approval) => approval.status === "pending"),
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Chef could not refresh the workspace.");
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(timer);
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled) return;
    void api.harnesses().then(setHarnesses).catch(() => setHarnesses([]));
    void api.project().then((project) => setProjectName(project.name || "Workspace")).catch(() => undefined);
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      threadHistoryLoader.invalidate();
      return;
    }

    const loadThreadNote = (threadId: string | null) => {
      if (!threadId) {
        threadHistoryLoader.invalidate();
        setChefNote(DEFAULT_CHEF_NOTE);
        return;
      }
      void threadHistoryLoader.load(threadId).then((result) => {
        if (!result.current) return;
        const latest = [...result.messages].reverse().find((message) => message.role === "assistant" && message.content.trim());
        setChefNote(latest?.content ?? DEFAULT_CHEF_NOTE);
      }).catch(() => undefined);
    };

    loadThreadNote(loadSelectedThreadId());
    const onThreadChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ threadId?: string | null }>).detail;
      const nextThreadId = detail?.threadId ?? loadSelectedThreadId();
      setSelectedThreadId(nextThreadId);
      setOptimisticGoal("");
      loadThreadNote(nextThreadId);
      void refresh();
    };
    window.addEventListener(SELECTED_THREAD_EVENT, onThreadChanged);
    return () => {
      threadHistoryLoader.invalidate();
      window.removeEventListener(SELECTED_THREAD_EVENT, onThreadChanged);
    };
  }, [enabled, refresh, threadHistoryLoader]);

  useEffect(() => {
    if (!enabled) return;
    const es = new EventSource("/api/events?types=canvas.*,mission.*,approval.*,node.*");
    es.onmessage = () => void refresh();
    return () => es.close();
  }, [enabled, refresh]);

  const latestMission = useMemo(
    () => [...snapshot.missions].sort((a, b) => b.updatedAt - a.updatedAt)[0],
    [snapshot.missions],
  );
  const currentStatus = latestMission?.status ?? missionStatusFor(snapshot);
  const focusGoal = latestMission?.goal || optimisticGoal;
  const missionTaskIds = useMemo(() => new Set(latestMission?.taskIds ?? []), [latestMission?.taskIds]);
  const missionTaskOrder = useMemo(
    () => new Map((latestMission?.taskIds ?? []).map((taskId, index) => [taskId, index])),
    [latestMission?.taskIds],
  );
  const taskById = useMemo(() => new Map(snapshot.tasks.map((task) => [task.id, task])), [snapshot.tasks]);
  const allCanvasNodeById = useMemo(() => new Map(snapshot.nodes.map((node) => [node.id, node])), [snapshot.nodes]);

  useEffect(() => {
    if (latestMission?.goal) setOptimisticGoal("");
  }, [latestMission?.goal]);

  const visibleCanvasNodes = useMemo(() => {
    const candidates = latestMission
      ? snapshot.nodes.filter((node) => {
          if (node.taskId && missionTaskIds.has(node.taskId)) return true;
          const task = node.taskId ? taskById.get(node.taskId) : undefined;
          return isWorkspaceHelper(node, task);
        })
      : snapshot.nodes;

    // One task can be represented by multiple runtime canvas objects (for
    // example a blueprint plus a proxy). The friendly workspace shows one
    // canonical visual object per task and leaves the full topology to
    // Advanced mode.
    const byTask = new Map<string, UiCanvasNode>();
    const standalone: UiCanvasNode[] = [];
    for (const node of candidates) {
      if (!node.taskId) {
        standalone.push(node);
        continue;
      }
      const current = byTask.get(node.taskId);
      if (!current) {
        byTask.set(node.taskId, node);
        continue;
      }
      const currentScore = nodeProjectionScore(current);
      const nextScore = nodeProjectionScore(node);
      if (nextScore > currentScore || (nextScore === currentScore && node.updatedAt > current.updatedAt)) {
        byTask.set(node.taskId, node);
      }
    }

    return [...byTask.values(), ...standalone].sort((a, b) => {
      const aOrder = a.taskId ? missionTaskOrder.get(a.taskId) : undefined;
      const bOrder = b.taskId ? missionTaskOrder.get(b.taskId) : undefined;
      if (aOrder !== undefined && bOrder !== undefined) return aOrder - bOrder;
      if (aOrder !== undefined) return -1;
      if (bOrder !== undefined) return 1;
      return a.updatedAt - b.updatedAt;
    });
  }, [latestMission, snapshot.nodes, missionTaskIds, taskById, missionTaskOrder]);

  const canvasNodeById = useMemo(
    () => new Map(visibleCanvasNodes.map((node) => [node.id, node])),
    [visibleCanvasNodes],
  );
  const canonicalNodeIdByTaskId = useMemo(
    () => new Map(visibleCanvasNodes.flatMap((node) => node.taskId ? [[node.taskId, node.id] as const] : [])),
    [visibleCanvasNodes],
  );

  useEffect(() => {
    if (selectedNodeId && !canvasNodeById.has(selectedNodeId)) setSelectedNodeId(null);
  }, [selectedNodeId, canvasNodeById]);

  const flowNodes = useMemo(() => {
    const nodes: Node[] = visibleCanvasNodes.map((node, index) => {
      const task = node.taskId ? taskById.get(node.taskId) : undefined;
      return {
        id: node.id,
        type: "living",
        position: semanticPosition(index, visibleCanvasNodes.length),
        draggable: false,
        selectable: true,
        data: {
          label: node.label,
          status: taskStatus(task, node),
          icon: nodeIcon(node, task),
          kind: node.kind,
          harnessId: node.harnessId,
          missionMember: Boolean(node.taskId && missionTaskIds.has(node.taskId)),
        } satisfies LivingNodeData,
      };
    });

    if (focusGoal) {
      const relevantTasks = latestMission
        ? snapshot.tasks.filter((task) => missionTaskIds.has(task.id))
        : snapshot.tasks;
      const completed = relevantTasks.filter((task) => task.status === "completed").length;
      nodes.push({
        id: "chef:mission-focus",
        type: "mission",
        position: { x: -155, y: -88 },
        draggable: false,
        selectable: false,
        data: {
          goal: focusGoal,
          status: currentStatus,
          completed,
          total: relevantTasks.length,
        } satisfies MissionNodeData,
      });
    }
    return nodes;
  }, [visibleCanvasNodes, snapshot.tasks, taskById, missionTaskIds, focusGoal, latestMission, currentStatus]);

  const flowNodeById = useMemo(() => new Map(flowNodes.map((node) => [node.id, node])), [flowNodes]);

  const flowEdges = useMemo(() => {
    const edges: Edge[] = [];
    const seen = new Set<string>();

    const canonicalIdFor = (rawId: string): string | null => {
      if (canvasNodeById.has(rawId)) return rawId;
      const raw = allCanvasNodeById.get(rawId);
      if (!raw?.taskId) return null;
      return canonicalNodeIdByTaskId.get(raw.taskId) ?? null;
    };

    for (const edge of snapshot.edges) {
      const sourceId = canonicalIdFor(edge.source);
      const targetId = canonicalIdFor(edge.target);
      if (!sourceId || !targetId || sourceId === targetId) continue;
      const key = `${sourceId}->${targetId}:${edge.type ?? "communication"}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const source = canvasNodeById.get(sourceId);
      const target = canvasNodeById.get(targetId);
      const sourceTask = source?.taskId ? taskById.get(source.taskId) : undefined;
      const targetTask = target?.taskId ? taskById.get(target.taskId) : undefined;
      const sourceActive = Boolean(source && ["working", "starting"].includes(taskStatus(sourceTask, source)));
      const targetActive = Boolean(target && ["working", "starting"].includes(taskStatus(targetTask, target)));
      const handles = routeHandles(flowNodeById.get(sourceId), flowNodeById.get(targetId));

      edges.push({
        id: `living:${key}`,
        source: sourceId,
        target: targetId,
        sourceHandle: handles.sourceHandle,
        targetHandle: handles.targetHandle,
        type: "bezier",
        className: `chef-living-edge ${sourceActive || targetActive ? "is-active" : ""}`,
        animated: false,
      });
    }

    if (focusGoal) {
      const missionNode = flowNodeById.get("chef:mission-focus");
      for (const node of visibleCanvasNodes) {
        if (!node.taskId || !missionTaskIds.has(node.taskId)) continue;
        const handles = routeHandles(missionNode, flowNodeById.get(node.id));
        edges.push({
          id: `chef:mission:${node.id}`,
          source: "chef:mission-focus",
          target: node.id,
          sourceHandle: handles.sourceHandle,
          targetHandle: handles.targetHandle,
          type: "bezier",
          className: "chef-mission-edge",
          selectable: false,
        });
      }
    }
    return edges;
  }, [snapshot.edges, canvasNodeById, allCanvasNodeById, canonicalNodeIdByTaskId, taskById, focusGoal, visibleCanvasNodes, missionTaskIds, flowNodeById]);

  const selectedNode = selectedNodeId ? canvasNodeById.get(selectedNodeId) : undefined;
  const selectedTask = selectedNode?.taskId ? taskById.get(selectedNode.taskId) : undefined;

  const sendGoal = useCallback(async (preset?: string) => {
    const text = (preset ?? input).trim();
    const submittedThreadId = loadSelectedThreadId();
    const submissionKey = threadSubmissionKey(submittedThreadId);
    if (!text || submittingThreadKeys.has(submissionKey)) return;
    setInput("");
    setOptimisticGoal(text);
    setChefNote(missionSubmissionAcknowledgement());
    setSubmittingThreadKeys((current) => setThreadSubmissionPending(current, submissionKey, true));
    setToolsOpen(false);
    try {
      const result = await api.chat(text);
      if (loadSelectedThreadId() !== submittedThreadId) return;
      if (!result.ok) {
        setChefNote(result.report || "I couldn't start that work yet.");
      } else if (result.report) {
        setChefNote(result.report);
      }
      void refresh();
    } catch (reason) {
      if (loadSelectedThreadId() !== submittedThreadId) return;
      setChefNote(reason instanceof Error ? reason.message : "Chef could not start the work.");
    } finally {
      setSubmittingThreadKeys((current) => setThreadSubmissionPending(current, submissionKey, false));
    }
  }, [input, submittingThreadKeys, refresh]);

  const addNode = useCallback(async (inputNode: { type: string; label: string; kind: "agent" | "tool"; harnessId?: string }) => {
    try {
      setToolsOpen(false);
      setChefNote(`Adding ${inputNode.label} to the workspace…`);
      const index = snapshot.nodes.length;
      const angle = (index / Math.max(1, index + 1)) * Math.PI * 2;
      const position = { x: 420 + Math.cos(angle) * 220, y: 320 + Math.sin(angle) * 160 };
      const { taskId } = await api.createNode({
        type: inputNode.type,
        title: inputNode.label,
        kind: inputNode.kind,
        position,
        config: { livingPinned: true },
        assignedTo: inputNode.harnessId,
        autoDispatch: inputNode.kind === "agent" || inputNode.type === "tool.terminal",
      });
      await api.patchCanvas({
        upsertNodes: [{
          id: taskId,
          taskId,
          label: inputNode.label,
          nodeType: "blueprint",
          kind: inputNode.kind,
          harnessId: inputNode.harnessId ?? (inputNode.type === "tool.terminal" ? "generic" : null),
          config: { livingPinned: true },
          position,
        }],
      });
      if (inputNode.type === "tool.browser") await api.activateNode(taskId);
      setChefNote(`${inputNode.label} is here. ✦`);
      void refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `Could not add ${inputNode.label}.`);
    }
  }, [snapshot.nodes.length, refresh]);

  const sendDirect = useCallback(async () => {
    if (!selectedNode || !directMessage.trim() || directSending) return;
    const message = directMessage.trim();
    setDirectSending(true);
    try {
      await api.interveneNode(selectedNode.id, message);
      setDirectMessage("");
      setChefNote(`Sent to ${selectedNode.label}.`);
      void refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not send that message.");
    } finally {
      setDirectSending(false);
    }
  }, [selectedNode, directMessage, directSending, refresh]);

  const openAdvanced = useCallback(() => {
    localStorage.setItem("chef:view-mode", "power");
    setEnabled(false);
  }, []);

  const switchProject = useCallback(async () => {
    try {
      const result = await api.pickProject();
      if (result.path && !result.cancelled) window.location.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not open another project.");
    }
  }, []);

  if (!enabled) return null;

  const agentHarnesses = harnesses.filter((harness) => harness.available && harness.id !== "generic").slice(0, 3);
  const hasWork = Boolean(focusGoal || visibleCanvasNodes.length > 0);

  return (
    <div className="chef-living-shell" aria-label="Chef living workspace">
      <header className="chef-living-topbar">
        <button className="chef-brand" type="button" onClick={() => inputRef.current?.focus()}>
          <span className="chef-brand__mark">C</span>
          <span><strong>Chef</strong><small>your tiny AI crew</small></span>
        </button>

        <button className="chef-project-pill" type="button" onClick={() => void switchProject()} title="Switch project">
          <span className="chef-project-pill__dot" />
          {projectName}
          <span aria-hidden="true">⌄</span>
        </button>

        <div className="chef-living-topbar__actions">
          <span className="chef-work-status" data-status={currentStatus}>
            <i /> {friendlyStatus(currentStatus)}
          </span>
          <button className="chef-advanced-button" type="button" onClick={openAdvanced}>
            Advanced
            <span aria-hidden="true">↗</span>
          </button>
        </div>
      </header>

      <main className="chef-living-stage">
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={NODE_TYPES}
          onNodeClick={(_, node) => node.id !== "chef:mission-focus" && setSelectedNodeId(node.id)}
          onPaneClick={() => setSelectedNodeId(null)}
          nodesDraggable={false}
          nodesConnectable={false}
          fitView
          fitViewOptions={{ padding: 0.34, maxZoom: 1.05 }}
          minZoom={0.45}
          maxZoom={1.5}
          panOnScroll
          zoomOnDoubleClick={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={28} size={1} color="rgba(96, 73, 67, 0.11)" />
        </ReactFlow>

        {!hasWork && (
          <section className="chef-empty-hello">
            <div className="chef-empty-hello__orbit" aria-hidden="true"><i /><i /><i /></div>
            <span className="chef-empty-hello__spark">✦</span>
            <h1>What should we work on?</h1>
            <p>Drop me a goal. I'll bring in the right people and tools as the work grows.</p>
          </section>
        )}

        {selectedNode && (
          <aside className="chef-node-popover" aria-label={`${selectedNode.label} details`}>
            <button className="chef-node-popover__close" type="button" onClick={() => setSelectedNodeId(null)} aria-label="Close">×</button>
            <div className="chef-node-popover__heading">
              <span className="chef-node-popover__icon">{nodeIcon(selectedNode, selectedTask)}</span>
              <div>
                <strong>{selectedNode.label}</strong>
                <span>{friendlyStatus(taskStatus(selectedTask, selectedNode))}</span>
              </div>
            </div>
            <p>{selectedNode.kind === "agent" ? "A teammate Chef can talk to and delegate work to." : "A useful surface in this workspace."}</p>
            {selectedNode.harnessId && <span className="chef-node-popover__powered">Powered by {selectedNode.harnessId}</span>}
            <div className="chef-node-popover__message">
              <textarea
                value={directMessage}
                onChange={(event) => setDirectMessage(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") void sendDirect();
                }}
                placeholder={`Ask ${selectedNode.label} something…`}
                rows={2}
              />
              <button type="button" onClick={() => void sendDirect()} disabled={!directMessage.trim() || directSending}>Send</button>
            </div>
            <div className="chef-node-popover__actions">
              {(selectedNode.kind === "agent" || selectedNode.kind === "tool") && (
                <button type="button" onClick={() => void api.activateNode(selectedNode.id).then(refresh).catch((reason) => setError(reason instanceof Error ? reason.message : "Could not open this node."))}>
                  Open
                </button>
              )}
              {selectedTask?.status === "failed" && (
                <button type="button" onClick={() => void api.retryNode(selectedTask.id).then(refresh).catch((reason) => setError(reason instanceof Error ? reason.message : "Retry failed."))}>
                  Try again
                </button>
              )}
              <button type="button" className="is-quiet" onClick={openAdvanced}>Details ↗</button>
            </div>
          </aside>
        )}

        {snapshot.approvals.length > 0 && (
          <div className="chef-approval-stack" aria-label="Approvals needed">
            {snapshot.approvals.map((approval) => (
              <article key={approval.id} className="chef-approval-card">
                <span className="chef-approval-card__icon">?</span>
                <div>
                  <strong>Chef needs your okay</strong>
                  <p>{approval.reason}</p>
                  <div>
                    <button type="button" onClick={() => void api.approve(approval.id, "accept").then(refresh)}>Looks good</button>
                    <button type="button" className="is-quiet" onClick={() => void api.approve(approval.id, "reject").then(refresh)}>Not yet</button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}

        <section className="chef-command-dock" aria-label="Talk to Chef">
          {chefNote && (
            <div className="chef-note" key={chefNote}>
              <span className="chef-note__avatar">✦</span>
              <p>{chefNote}</p>
              {sending && <span className="chef-thinking-dots" aria-label="Chef is thinking"><i /><i /><i /></span>}
            </div>
          )}

          {!focusGoal && !sending && (
            <div className="chef-quick-prompts">
              {QUICK_PROMPTS.map((prompt) => (
                <button key={prompt} type="button" onClick={() => void sendGoal(prompt)}>{prompt}</button>
              ))}
            </div>
          )}

          {toolsOpen && (
            <div className="chef-tool-shelf">
              <div className="chef-tool-shelf__label">Bring something in</div>
              <div className="chef-tool-shelf__items">
                {agentHarnesses.map((harness) => (
                  <button key={harness.id} type="button" onClick={() => void addNode({ type: `harness.${harness.id}`, label: harness.name, kind: "agent", harnessId: harness.id })}>
                    <span>✦</span><strong>{harness.name}</strong><small>AI helper</small>
                  </button>
                ))}
                <button type="button" onClick={() => void addNode({ type: "tool.file", label: "File", kind: "tool" })}>
                  <span>▤</span><strong>File</strong><small>Data or document</small>
                </button>
                <button type="button" onClick={() => void addNode({ type: "tool.browser", label: "Browser", kind: "tool" })}>
                  <span>◎</span><strong>Browser</strong><small>Web research</small>
                </button>
                <button type="button" onClick={() => void addNode({ type: "tool.terminal", label: "Terminal", kind: "tool", harnessId: "generic" })}>
                  <span>&gt;_</span><strong>Terminal</strong><small>Command line</small>
                </button>
                <button type="button" className="is-more" onClick={openAdvanced}>
                  <span>＋</span><strong>More</strong><small>All tools</small>
                </button>
              </div>
            </div>
          )}

          <div className="chef-composer">
            <button
              className={`chef-composer__plus ${toolsOpen ? "is-open" : ""}`}
              type="button"
              onClick={() => setToolsOpen((value) => !value)}
              aria-label="Add a teammate, file, or tool"
              aria-expanded={toolsOpen}
            >
              +
            </button>
            <textarea
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void sendGoal();
                }
              }}
              placeholder={focusGoal ? "Ask Chef to change or do anything…" : "What do you want to get done?"}
              rows={1}
              disabled={sending}
            />
            <span className="chef-composer__hint">↵ send</span>
            <button className="chef-composer__send" type="button" onClick={() => void sendGoal()} disabled={!input.trim() || sending} aria-label="Send to Chef">
              ↑
            </button>
          </div>
        </section>
      </main>

      {error && (
        <div className="chef-friendly-error" role="alert">
          <span>Oops.</span>
          <p>{error}</p>
          <button type="button" onClick={() => setError(null)}>Okay</button>
        </div>
      )}
    </div>
  );
}
