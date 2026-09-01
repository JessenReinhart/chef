import type { ChatMessage } from "./types";
import { foregroundThreadId, resolveHomeThreadSelection } from "./threadSelection.ts";

export interface UiThread {
  id: string;
  workspaceId: string;
  title: string;
  status: "active" | "archived";
  summary?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface ThreadChatResult {
  threadId: string;
  missionId?: string;
  taskIds?: string[];
  report: string;
  ok: boolean;
}

const SELECTED_THREAD_KEY = "chef:selected-thread";
export const SELECTED_THREAD_EVENT = "chef:selected-thread-changed";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Keep the HTTP status when the server did not return JSON.
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

export async function listThreads(): Promise<UiThread[]> {
  const response = await request<{ ok: boolean; data: UiThread[] }>("/api/threads");
  const rememberedId = loadSelectedThreadId();
  const resolvedId = foregroundThreadId(resolveHomeThreadSelection(response.data, rememberedId));
  if (resolvedId !== rememberedId) saveSelectedThreadId(resolvedId);
  return response.data;
}

export async function createThread(title: string): Promise<UiThread> {
  const response = await request<{ ok: boolean; data: UiThread }>("/api/threads", {
    method: "POST",
    body: JSON.stringify({ title }),
  });
  return response.data;
}

export async function renameThread(threadId: string, title: string): Promise<UiThread> {
  const response = await request<{ ok: boolean; data: UiThread }>(`/api/threads/${encodeURIComponent(threadId)}`, {
    method: "PATCH",
    body: JSON.stringify({ title }),
  });
  return response.data;
}

export async function archiveThread(threadId: string): Promise<UiThread> {
  const response = await request<{ ok: boolean; data: UiThread }>(`/api/threads/${encodeURIComponent(threadId)}/archive`, {
    method: "POST",
  });
  return response.data;
}

export async function threadMessages(threadId: string): Promise<ChatMessage[]> {
  const response = await request<{ ok: boolean; data: ChatMessage[] }>(`/api/threads/${encodeURIComponent(threadId)}/messages`);
  return response.data;
}

export async function sendThreadMessage(threadId: string, message: string): Promise<ThreadChatResult> {
  const response = await request<{ ok: boolean; data: ThreadChatResult }>(`/api/threads/${encodeURIComponent(threadId)}/chat`, {
    method: "POST",
    body: JSON.stringify({ message }),
  });
  return response.data;
}

export function loadSelectedThreadId(): string | null {
  return localStorage.getItem(SELECTED_THREAD_KEY);
}

export function saveSelectedThreadId(threadId: string | null): void {
  const previous = loadSelectedThreadId();
  if (threadId) localStorage.setItem(SELECTED_THREAD_KEY, threadId);
  else localStorage.removeItem(SELECTED_THREAD_KEY);
  if (previous !== threadId) window.dispatchEvent(new CustomEvent(SELECTED_THREAD_EVENT, { detail: { threadId } }));
}
