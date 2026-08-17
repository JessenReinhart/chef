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
} from "./types";
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

export interface CreateNodeResult {
  taskId: string;
  workflowNodeId: string;
}

export class Api {
  private base: string;
  constructor(base = "") {
    this.base = base;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
      ...init,
    });
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) message = body.error;
      } catch {
        // non-JSON error body — keep status message
      }
      throw new Error(message);
    }
    return (await res.json()) as T;
  }

  // ── Harnesses ────────────────────────────────────────────────────
  async harnesses(): Promise<HarnessInfo[]> {
    const data = await this.request<{ ok: boolean; data: HarnessInfo[] }>("/api/harnesses");
    return data.data;
  }

  // ── State & graph ────────────────────────────────────────────────
  async stateRaw(): Promise<{
    tasks: UiTask[];
    sessions: unknown[];
    approvals: Array<{ id: string; reason: string; taskId: string; status: string }>;
    canvasNodes: UiCanvasNode[];
    canvasEdges: UiCanvasEdge[];
  }> {
    return this.request<{
      tasks: UiTask[];
      sessions: unknown[];
      approvals: Array<{ id: string; reason: string; taskId: string; status: string }>;
      canvasNodes: UiCanvasNode[];
      canvasEdges: UiCanvasEdge[];
    }>("/api/state");
  }

  // ── Canvas graph patch (runtime-owned projection) ───────────────
  async patchCanvas(patch: CanvasPatch): Promise<CanvasPatchResult> {
    const res = await fetch(`${this.base}/api/canvas/patch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    const body = (await res.json()) as CanvasPatchResult;
    if (res.status === 422 && body.ok === false) {
      // Rejected patch — return the result so callers can surface the error.
      return body;
    }
    if (!res.ok) {
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    return body;
  }

  // ── Nodes ────────────────────────────────────────────────────────
  async createNode(input: CreateNodeInput): Promise<CreateNodeResult> {
    const data = await this.request<{ ok: boolean; data: CreateNodeResult }>("/api/nodes", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return data.data;
  }

  async patchNode(
    taskId: string,
    patch: { title?: string; config?: Record<string, unknown>; position?: { x: number; y: number }; dependencies?: string[] },
  ): Promise<void> {
    await this.request(`/api/nodes/${taskId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  async deleteNode(taskId: string): Promise<void> {
    await this.request(`/api/nodes/${taskId}`, { method: "DELETE" });
  }

  async runNode(input: { nodeId: string; title?: string; workflowNodeId?: string; assignedTo?: string }): Promise<{ taskId: string }> {
    const data = await this.request<{ ok: boolean; data: { taskId: string } }>("/api/nodes/run", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return data.data;
  }

  async retryNode(taskId: string): Promise<void> {
    await this.request(`/api/nodes/${taskId}/retry`, { method: "POST" });
  }

  async cancelNode(taskId: string): Promise<void> {
    await this.request(`/api/nodes/${taskId}/cancel`, { method: "POST" });
  }

  // ── Edges (dependencies) ────────────────────────────────────────
  async createEdge(source: string, target: string): Promise<void> {
    await this.request("/api/edges", {
      method: "POST",
      body: JSON.stringify({ source, target }),
    });
  }

  async deleteEdge(source: string, target: string): Promise<void> {
    await this.request(`/api/edges/${source}->${target}`, { method: "DELETE" });
  }

  // ── Dispatch ────────────────────────────────────────────────────
  async dispatch(): Promise<number> {
    const data = await this.request<{ ok: boolean; data: { dispatched: number } }>("/api/dispatch", { method: "POST" });
    return data.data.dispatched;
  }

  // ── Chat ────────────────────────────────────────────────────────
  async chat(message: string): Promise<{ ok: boolean; taskIds: string[]; report: string }> {
    return this.request<{ ok: boolean; data: { ok: boolean; taskIds: string[]; report: string } }>("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message }),
    }).then((r) => r.data);
  }

  async chatMessages(): Promise<ChatMessage[]> {
    const data = await this.request<{ ok: boolean; data: ChatMessage[] }>("/api/chat/messages");
    return data.data;
  }

  // ── Templates ───────────────────────────────────────────────────
  async templates(): Promise<Template[]> {
    const data = await this.request<{ ok: boolean; data: Template[] }>("/api/templates");
    return data.data;
  }

  async createTemplate(input: { name: string; description?: string; nodes: unknown[]; metadata?: Record<string, unknown> }): Promise<void> {
    await this.request("/api/templates", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  // ── Sessions / terminals ────────────────────────────────────────
  async sendInput(sessionId: string, data: string): Promise<void> {
    await this.request("/api/sessions/send", { method: "POST", body: JSON.stringify({ sessionId, data }) });
  }

  async interruptSession(sessionId: string): Promise<void> {
    await this.request("/api/sessions/interrupt", { method: "POST", body: JSON.stringify({ sessionId }) });
  }

  // ── Approvals ───────────────────────────────────────────────────
  async approve(approvalId: string, decision: "accept" | "reject"): Promise<void> {
    await this.request(`/api/approvals/${approvalId}/${decision}`, {
      method: "POST",
      body: JSON.stringify({ approver: "ui" }),
    });
  }
}

export const api = new Api();
