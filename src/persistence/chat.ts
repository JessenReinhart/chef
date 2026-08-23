/**
 * Chef P0 — Chat persistence layer.
 *
 * Thin wrapper around Repository.messages with chat-specific helpers.
 * Legacy workspace-global chat keeps channel="chat". Thread-scoped chat uses
 * a deterministic private channel per Thread until the message schema gains a
 * first-class thread_id column. Callers use Thread ids, never channel names.
 */

import type { AgentMessage, MessageId, Timestamp, WorkspaceId } from "../core/types.ts";
import type { ThreadId } from "../core/threads.ts";
import { Repository } from "./database.ts";
import { createThreadRepository } from "./threads.ts";

export interface ChatMessage {
  id: MessageId;
  workspaceId: WorkspaceId;
  threadId?: ThreadId;
  role: "user" | "assistant" | "system";
  content: string;
  metadata?: Record<string, unknown>;
  timestamp: Timestamp;
}

export interface ChatMessageInput {
  id?: MessageId;
  workspaceId: WorkspaceId;
  threadId?: ThreadId;
  role: "user" | "assistant" | "system";
  content: string;
  metadata?: Record<string, unknown>;
  timestamp?: Timestamp;
}

const CHAT_CHANNEL = "chat";
const THREAD_CHAT_PREFIX = `${CHAT_CHANNEL}:thread:`;

function channelForThread(threadId?: ThreadId): string {
  return threadId ? `${THREAD_CHAT_PREFIX}${encodeURIComponent(threadId)}` : CHAT_CHANNEL;
}

function toAgentMessage(input: ChatMessageInput): AgentMessage {
  const now = input.timestamp ?? Date.now();
  return {
    id: input.id ?? crypto.randomUUID(),
    workspaceId: input.workspaceId,
    from: input.role === "user" ? "user" : "assistant",
    to: input.role === "user" ? "assistant" : "user",
    channel: channelForThread(input.threadId),
    type: "message",
    payload: {
      content: input.content,
      metadata: input.metadata ?? {},
    },
    timestamp: now,
  };
}

function fromAgentMessage(msg: AgentMessage, threadId?: ThreadId): ChatMessage {
  const payload = msg.payload as Record<string, unknown> | undefined;
  return {
    id: msg.id,
    workspaceId: msg.workspaceId,
    threadId,
    role: msg.from === "user" ? "user" : "assistant",
    content: (payload?.content as string) ?? "",
    metadata: (payload?.metadata as Record<string, unknown>) ?? {},
    timestamp: msg.timestamp,
  };
}

/** Chat-specific repository methods (delegates durable message writes to Repository). */
export class ChatRepository {
  readonly #repo: Repository;
  readonly #threads;

  constructor(repo: Repository) {
    this.#repo = repo;
    this.#threads = createThreadRepository(repo);
  }

  #assertOwnedThread(workspaceId: WorkspaceId, threadId: ThreadId): void {
    const thread = this.#threads.get(threadId);
    if (!thread || thread.workspaceId !== workspaceId) {
      throw new Error(`Thread not found in workspace: ${threadId}`);
    }
  }

  /** Insert a chat message, optionally inside one durable Thread. */
  insert(input: ChatMessageInput): ChatMessage {
    if (input.threadId) this.#assertOwnedThread(input.workspaceId, input.threadId);
    const agentMsg = toAgentMessage(input);
    this.#repo.insertMessage({
      id: agentMsg.id,
      workspaceId: agentMsg.workspaceId,
      from: agentMsg.from,
      to: agentMsg.to,
      channel: agentMsg.channel,
      type: agentMsg.type,
      payload: agentMsg.payload,
      timestamp: agentMsg.timestamp,
    });
    if (input.threadId) this.#threads.touch(input.threadId);
    return fromAgentMessage(agentMsg, input.threadId);
  }

  /** List chat messages for the legacy workspace chat or one selected Thread. */
  list(workspaceId: WorkspaceId, threadId?: ThreadId): ChatMessage[] {
    if (threadId) this.#assertOwnedThread(workspaceId, threadId);
    const msgs = this.#repo.listMessages(workspaceId, channelForThread(threadId));
    return msgs
      .map((msg) => fromAgentMessage(msg, threadId))
      .sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
  }

  /** List chat messages after a given timestamp for one continuity boundary. */
  listSince(workspaceId: WorkspaceId, since: Timestamp, threadId?: ThreadId): ChatMessage[] {
    return this.list(workspaceId, threadId).filter((message) => message.timestamp > since);
  }

  /** Get total count of chat messages for one continuity boundary. */
  count(workspaceId: WorkspaceId, threadId?: ThreadId): number {
    if (threadId) this.#assertOwnedThread(workspaceId, threadId);
    const row = this.#repo.db
      .prepare(`SELECT COUNT(*) as count FROM messages WHERE workspace_id = ? AND channel = ?`)
      .get(workspaceId, channelForThread(threadId)) as { count: number } | undefined;
    return row?.count ?? 0;
  }
}

/** Factory for creating a ChatRepository from a base Repository. */
export function createChatRepository(repo: Repository): ChatRepository {
  return new ChatRepository(repo);
}
