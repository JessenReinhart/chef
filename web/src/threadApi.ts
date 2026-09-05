import type { ChatMessage } from "./types";
import { beginThreadHistoryMutation, foregroundThreadId, resolveHomeThreadSelection } from "./threadSelection.ts";

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

function simpleModeActionOwner(): { threadId: string | null; guarded: boolean } {
  return {
    threadId: loadSelectedThreadId(),
    guarded: localStorage.getItem("chef:view-mode") !== "power",
  };
}

function assertThreadActionStillOwnsForeground(
  owner: { threadId: string | null; guarded: boolean },
  transferredThreadId: string | null = null,
): void {
  if (!owner.guarded) return;
  const selectedThreadId = loadSelectedThreadId();
  if (selectedThreadId === owner.threadId) return;
  if (owner.threadId === null && transferredThreadId !== null && selectedThreadId === transferredThreadId) return;
  throw new Error("Thread selection changed while the action was completing");
}

export async function listThreads(): Promise<UiThread[]> {
  const response = await request<{ ok: boolean; data: UiThread[] }>("/api/threads");
  const rememberedId = loadSelectedThreadId();
  const resolvedId = foregroundThreadId(resolveHomeThreadSelection(response.data, rememberedId));
  if (resolvedId !== rememberedId) saveSelectedThreadId(resolvedId);
  return response.data;
}

export async function createThread(title: string): Promise<UiThread> {
  const owner = simpleModeActionOwner();
  const response = await request<{ ok: boolean; data: UiThread }>("/api/threads", {
    method: "POST",
    body: JSON.stringify({ title }),
  });
  // The server mutation remains authoritative and will appear in the next list refresh.
  // A fresh workspace may legitimately transfer ownership from no Thread to the exact
  // Thread this request created; every unrelated foreground change must fail closed.
  assertThreadActionStillOwnsForeground(owner, response.data.id);
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
  const owner = simpleModeActionOwner();
  const response = await request<{ ok: boolean; data: UiThread }>(`/api/threads/${encodeURIComponent(threadId)}/archive`, {
    method: "POST",
  });
  // Archive still succeeds server-side. Suppressing a stale foreground settlement lets
  // the periodic Thread refresh reconcile bookkeeping without stealing user context.
  assertThreadActionStillOwnsForeground(owner);
  return response.data;
}

export async function threadMessages(threadId: string): Promise<ChatMessage[]> {
  const selectedThreadAtStart = loadSelectedThreadId();
  const simpleModeAtStart = localStorage.getItem("chef:view-mode") !== "power";
  const response = await request<{ ok: boolean; data: ChatMessage[] }>(`/api/threads/${encodeURIComponent(threadId)}/messages`);
  if (simpleModeAtStart && (selectedThreadAtStart !== threadId || loadSelectedThreadId() !== selectedThreadAtStart)) {
    throw new Error("Thread selection changed while history was loading");
  }
  return response.data;
}

export async function sendThreadMessage(threadId: string, message: string): Promise<ThreadChatResult> {
  const finishHistoryMutation = beginThreadHistoryMutation(threadId);
  try {
    const response = await request<{ ok: boolean; data: ThreadChatResult }>(`/api/threads/${encodeURIComponent(threadId)}/chat`, {
      method: "POST",
      body: JSON.stringify({ message }),
    });
    return response.data;
  } finally {
    finishHistoryMutation();
  }
}

export function loadSelectedThreadId(): string | null {
  return localStorage.getItem(SELECTED_THREAD_KEY);
}

export function saveSelectedThreadId(threadId: string | null): void {
  const previous = loadSelectedThreadId();
  if (threadId) localStorage.setItem(SELECTED_THREAD_KEY, threadId);
  else localStorage.removeItem(SELECTED_THREAD_KEY);
  if (previous !== threadId && localStorage.getItem("chef:view-mode") !== "power") {
    window.dispatchEvent(new CustomEvent(SELECTED_THREAD_EVENT, { detail: { threadId } }));
  }
}
