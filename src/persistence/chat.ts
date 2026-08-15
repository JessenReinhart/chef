/**
 * Chef P0 — Chat persistence layer.
 *
 * Thin wrapper around Repository.messages with chat-specific helpers.
 * Uses channel="chat" for chat message isolation.
 */

import type { AgentMessage, AgentMessageType, ContextReference, MessageId, Timestamp, WorkspaceId } from "../core/types.ts";
import { Repository } from "./database.ts";

export interface ChatMessage {
	id: MessageId;
	workspaceId: WorkspaceId;
	role: "user" | "assistant" | "system";
	content: string;
	metadata?: Record<string, unknown>;
	timestamp: Timestamp;
}

export interface ChatMessageInput {
	id?: MessageId;
	workspaceId: WorkspaceId;
	role: "user" | "assistant" | "system";
	content: string;
	metadata?: Record<string, unknown>;
	timestamp?: Timestamp;
}

const CHAT_CHANNEL = "chat";

function toAgentMessage(input: ChatMessageInput): AgentMessage {
	const now = input.timestamp ?? Date.now();
	return {
		id: input.id ?? crypto.randomUUID(),
		workspaceId: input.workspaceId,
		from: input.role === "user" ? "user" : "assistant",
		to: input.role === "user" ? "assistant" : "user",
		channel: CHAT_CHANNEL,
		type: "message",
		payload: {
			content: input.content,
			metadata: input.metadata ?? {},
		},
		timestamp: now,
	};
}

function fromAgentMessage(msg: AgentMessage): ChatMessage {
	const payload = msg.payload as Record<string, unknown> | undefined;
	return {
		id: msg.id,
		workspaceId: msg.workspaceId,
		role: msg.from === "user" ? "user" : "assistant",
		content: (payload?.content as string) ?? "",
		metadata: (payload?.metadata as Record<string, unknown>) ?? {},
		timestamp: msg.timestamp,
	};
}

/** Chat-specific repository methods (delegates to Repository.messages). */
export class ChatRepository {
	constructor(private readonly repo: Repository) {}

	/** Insert a chat message. */
	insert(input: ChatMessageInput): ChatMessage {
		const agentMsg = toAgentMessage(input);
		this.repo.insertMessage({
			id: agentMsg.id,
			workspaceId: agentMsg.workspaceId,
			from: agentMsg.from,
			to: agentMsg.to,
			channel: agentMsg.channel,
			type: agentMsg.type,
			payload: agentMsg.payload,
			timestamp: agentMsg.timestamp,
		});
		return fromAgentMessage(agentMsg);
	}

	/** List all chat messages for a workspace (chronological). */
	list(workspaceId: WorkspaceId): ChatMessage[] {
		const msgs = this.repo.listMessages(workspaceId, CHAT_CHANNEL);
		return msgs.map(fromAgentMessage);
	}

	/** List chat messages after a given timestamp (for incremental sync). */
	listSince(workspaceId: WorkspaceId, since: Timestamp): ChatMessage[] {
		return this.list(workspaceId).filter((m) => m.timestamp > since);
	}

	/** Get total count of chat messages. */
	count(workspaceId: WorkspaceId): number {
		const row = this.repo.db
			.prepare(`SELECT COUNT(*) as count FROM messages WHERE workspace_id = ? AND channel = ?`)
			.get(workspaceId, CHAT_CHANNEL) as { count: number } | undefined;
		return row?.count ?? 0;
	}
}

/** Factory for creating a ChatRepository from a base Repository. */
export function createChatRepository(repo: Repository): ChatRepository {
	return new ChatRepository(repo);
}