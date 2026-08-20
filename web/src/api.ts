/**
 * Chef Web UI — API client.
 * All calls go through the Vite proxy → Chef runtime HTTP server (port 4321).
 */

import type {
  CanvasPatch,
  CanvasPatchResult,
  HarnessInfo,
  Template,
  UiGraph,
  ChatMessage,
  UiTask,
  UiCanvasNode,
  UiCanvasEdge,
  LlmStatus,
  ContextZone,
  ContextZoneInput,
  UiMission,
  UiAutomation,
  UiAutomationRun,
  UiRuntimeEvent,
} from "./types";

export interface RecentProject { path: string; name: string; openedAt: number; }
export interface ProjectInfo { path: string; name: string; recent: RecentProject[]; nativePicker: boolean; }
export interface OrchestratorProviderSettings { provider: "anthropic" | "openai" | "custom" | null; model: string; baseUrl?: string; configured: boolean; hasApiKey: boolean; }

export interface CreateNodeInput {
  type: string;
  title?: string;
  kind?: string;
  position?: { x: number; y: number };
  dependencies?: string[];
  config?: Record<string, unknown>;
  assignedTo?: string;
  autoDispatch?: boolean;
}

export interface CreateNodeResult { taskId: string; workflowNodeId: string; }

export class Api {
  private base: string;
  constructor(base = "") { this.base = base; }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.base}${path}`, { headers: { "content-type": "application/json", ...(init?.headers ?? {}) }, ...init });
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try { const body = (await res.json()) as { error?: string }; if (body.error) message = body.error; } catch { /* keep status */ }
      throw new Error(message);
    }
    return (await res.json()) as T;
  }

  async project(): Promise<ProjectInfo> { const data = await this.request<{ ok: boolean; data: ProjectInfo }>("/api/project"); return data.data; }
  async openProject(path: string): Promise<{ path?: string; reopening?: boolean; current?: boolean; cancelled?: boolean }> { const data = await this.request<{ ok: boolean; data: { path?: string; reopening?: boolean; current?: boolean; cancelled?: boolean } }>("/api/project/open", { method: "POST", body: JSON.stringify({ path }) }); return data.data; }
  async pickProject(): Promise<{ path?: string; reopening?: boolean; current?: boolean; cancelled?: boolean }> { const data = await this.request<{ ok: boolean; data: { path?: string; reopening?: boolean; current?: boolean; cancelled?: boolean } }>("/api/project/pick", { method: "POST" }); return data.data; }
  async orchestratorProvider(): Promise<OrchestratorProviderSettings> { const data = await this.request<{ ok: boolean; data: OrchestratorProviderSettings }>("/api/orchestrator/provider"); return data.data; }
  async saveOrchestratorProvider(input: { provider: string; model: string; baseUrl?: string; apiKey?: string }): Promise<void> { await this.request("/api/orchestrator/provider", { method: "PUT", body: JSON.stringify(input) }); }

  async harnesses(): Promise<HarnessInfo[]> { const data = await this.request<{ ok: boolean; data: HarnessInfo[] }>("/api/harnesses"); return data.data; }
  async capabilities(role: "engineer" | "orchestrator" | "human"): Promise<{ role: string; policy: Record<string, "allow" | "deny" | "approval"> }> { const data = await this.request<{ ok: boolean; data: { role: string; policy: Record<string, "allow" | "deny" | "approval"> } }>(`/api/capabilities?role=${role}`); return data.data; }
  async llmStatus(): Promise<LlmStatus> { const data = await this.request<{ ok: boolean; data: LlmStatus }>("/api/llm/status"); return data.data; }

  async stateRaw(): Promise<{ tasks: UiTask[]; sessions: unknown[]; approvals: Array<{ id: string; reason: string; taskId: string; status: string }>; canvasNodes: UiCanvasNode[]; canvasEdges: UiCanvasEdge[]; missions?: UiMission[]; automations?: UiAutomation[]; events: UiRuntimeEvent[]; }> {
    return this.request("/api/state");
  }

  async patchCanvas(patch: CanvasPatch): Promise<CanvasPatchResult> {
    const res = await fetch(`${this.base}/api/canvas/patch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
    const body = (await res.json()) as CanvasPatchResult;
    if (res.status === 422 && body.ok === false) return body;
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    return body;
  }

  async createNode(input: CreateNodeInput): Promise<CreateNodeResult> { const data = await this.request<{ ok: boolean; data: CreateNodeResult }>("/api/nodes", { method: "POST", body: JSON.stringify(input) }); return data.data; }
  async patchNode(taskId: string, patch: { title?: string; config?: Record<string, unknown>; position?: { x: number; y: number }; dependencies?: string[] }): Promise<void> { await this.request(`/api/nodes/${taskId}`, { method: "PATCH", body: JSON.stringify(patch) }); }
  async deleteNode(taskId: string): Promise<void> { await this.request(`/api/nodes/${taskId}`, { method: "DELETE" }); }
  async runNode(input: { nodeId: string; title?: string; workflowNodeId?: string; assignedTo?: string }): Promise<{ taskId: string }> { const data = await this.request<{ ok: boolean; data: { taskId: string } }>("/api/nodes/run", { method: "POST", body: JSON.stringify(input) }); return data.data; }
  async retryNode(taskId: string): Promise<void> { await this.request(`/api/nodes/${taskId}/retry`, { method: "POST" }); }
  async cancelNode(taskId: string): Promise<void> { await this.request(`/api/nodes/${taskId}/cancel`, { method: "POST" }); }
  async createEdge(source: string, target: string): Promise<void> { await this.request("/api/edges", { method: "POST", body: JSON.stringify({ source, target }) }); }
  async deleteEdge(source: string, target: string): Promise<void> { await this.request(`/api/edges/${source}->${target}`, { method: "DELETE" }); }
  async dispatch(): Promise<number> { const data = await this.request<{ ok: boolean; data: { dispatched: number } }>("/api/dispatch", { method: "POST" }); return data.data.dispatched; }
  async contextZones(): Promise<ContextZone[]> { const data = await this.request<{ ok: boolean; data: ContextZone[] }>("/api/context-scopes"); return data.data; }
  async automations(): Promise<UiAutomation[]> { const data = await this.request<{ ok: boolean; data: UiAutomation[] }>("/api/automations"); return data.data; }
  async runAutomation(id: string): Promise<UiAutomationRun> { const data = await this.request<{ ok: boolean; data: UiAutomationRun }>(`/api/automations/${encodeURIComponent(id)}/run`, { method: "POST" }); return data.data; }
  async stopAutomation(id: string): Promise<UiAutomationRun> { const data = await this.request<{ ok: boolean; data: UiAutomationRun }>(`/api/automations/${encodeURIComponent(id)}/stop`, { method: "POST" }); return data.data; }
  async activateNode(id: string): Promise<UiCanvasNode> { const data = await this.request<{ ok: boolean; data: UiCanvasNode }>(`/api/nodes/${encodeURIComponent(id)}/activate`, { method: "POST" }); return data.data; }
  async controlMission(id: string, action: "pause" | "resume" | "cancel"): Promise<UiMission> { const data = await this.request<{ ok: boolean; data: UiMission }>(`/api/missions/${encodeURIComponent(id)}/${action}`, { method: "POST" }); return data.data; }
  async redirectMission(id: string, goal: string): Promise<UiMission> { const data = await this.request<{ ok: boolean; data: UiMission }>(`/api/missions/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ goal }) }); return data.data; }
  async interveneNode(id: string, text: string): Promise<void> { await this.request(`/api/nodes/${encodeURIComponent(id)}/message`, { method: "POST", body: JSON.stringify({ message: text }) }); }
  async createContextZone(input: ContextZoneInput): Promise<ContextZone> { const data = await this.request<{ ok: boolean; data: ContextZone }>("/api/context-scopes", { method: "POST", body: JSON.stringify(input) }); return data.data; }
  async updateContextZone(id: string, input: Partial<ContextZoneInput>): Promise<ContextZone> { const data = await this.request<{ ok: boolean; data: ContextZone }>(`/api/context-scopes/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) }); return data.data; }
  async deleteContextZone(id: string): Promise<void> { await this.request(`/api/context-scopes/${encodeURIComponent(id)}`, { method: "DELETE" }); }
  async chat(message: string): Promise<{ ok: boolean; taskIds: string[]; report: string }> { return this.request<{ ok: boolean; data: { ok: boolean; taskIds: string[]; report: string } }>("/api/chat", { method: "POST", body: JSON.stringify({ message }) }).then((r) => r.data); }
  async chatMessages(): Promise<ChatMessage[]> { const data = await this.request<{ ok: boolean; data: ChatMessage[] }>("/api/chat/messages"); return data.data; }
  async templates(): Promise<Template[]> { const data = await this.request<{ ok: boolean; data: Template[] }>("/api/templates"); return data.data; }
  async createTemplate(input: { name: string; description?: string; nodes: unknown[]; metadata?: Record<string, unknown> }): Promise<void> { await this.request("/api/templates", { method: "POST", body: JSON.stringify(input) }); }
  async sendInput(sessionId: string, data: string): Promise<void> { await this.request("/api/sessions/send", { method: "POST", body: JSON.stringify({ sessionId, data }) }); }
  async interruptSession(sessionId: string): Promise<void> { await this.request("/api/sessions/interrupt", { method: "POST", body: JSON.stringify({ sessionId }) }); }
  async sendPeerMessage(sessionId: string, from: string, text: string): Promise<void> { await this.request(`/api/sessions/${sessionId}/message`, { method: "POST", body: JSON.stringify({ from, text }) }); }
  async sessions(): Promise<Array<{ id: string; taskId: string; status: string; pid: number }>> { const snapshot = await this.stateRaw(); return (snapshot.sessions as Array<{ id: string; taskId: string; status: string; pid: number }>).map((s) => ({ id: s.id, taskId: s.taskId, status: s.status, pid: s.pid })); }
  async sendToSession(sessionId: string, data: string): Promise<void> { await this.request("/api/sessions/send", { method: "POST", body: JSON.stringify({ sessionId, data }) }); }
  async approve(approvalId: string, decision: "accept" | "reject"): Promise<void> { await this.request(`/api/approvals/${approvalId}/${decision}`, { method: "POST", body: JSON.stringify({ approver: "ui" }) }); }
}

export const api = new Api();
