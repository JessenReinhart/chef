/**
 * Chef P0 — LLM Decision Provider (provider-neutral).
 *
 * Uses Anthropic SDK or OpenAI-compatible client with structured JSON schema validation.
 * Falls back to ScriptedDecisionProvider when no provider configured.
 * 60s timeout per proposal (configurable).
 */

import type {
	Decision,
	DecisionProvider,
	Plan,
	PlanProposalContext,
	PlanTask,
	PlanTaskOutcome,
	WorkspaceId,
} from "../core/types.ts";
import type { NodeDefinition } from "../core/nodes.ts";
import { nodeRegistry } from "../runtime/node-registry.ts";
import { ScriptedDecisionProvider } from "./orchestrator.ts";
import { Anthropic } from "@anthropic-ai/sdk";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface LLMDecisionProviderConfig {
	/** Provider: "anthropic" | "openai" | "custom" */
	provider: "anthropic" | "openai" | "custom";
	/** API key (from env) */
	apiKey: string;
	/** Model name (from env CHEF_MODEL) */
	model: string;
	/** Base URL for custom/OpenAI-compatible provider */
	baseUrl?: string;
	/** Request timeout in ms (default 60s) */
	timeoutMs?: number;
	/** Temperature for generation (default 0.2) */
	temperature?: number;
	/** Max output tokens (default 4096) */
	maxTokens?: number;
}

// ---------------------------------------------------------------------------
// Internal types / parsing
// ---------------------------------------------------------------------------

interface NodeTypeInfo {
	type: string;
	category: string;
	label: string;
	description: string;
	inputs: Array<{ id: string; label: string; type: string; required: boolean }>;
	outputs: Array<{ id: string; label: string; type: string; required: boolean }>;
	configSchema: Record<string, unknown>;
	configDefaults: Record<string, unknown>;
}

function asJsonObject(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("LLM response JSON must be an object");
	}
	return value as Record<string, unknown>;
}

function findBalancedObjectEnd(text: string, start: number): number | null {
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let index = start; index < text.length; index += 1) {
		const char = text[index];

		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === '"') inString = false;
			continue;
		}

		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === "{") {
			depth += 1;
			continue;
		}
		if (char === "}") {
			depth -= 1;
			if (depth === 0) return index;
			if (depth < 0) return null;
		}
	}

	return null;
}

/**
 * Parse one JSON object from model output.
 *
 * Some OpenAI-compatible/custom providers ignore JSON-only instructions and
 * wrap an otherwise valid object in markdown fences or explanatory text. We
 * tolerate only that outer wrapper. The JSON object itself must still parse
 * cleanly and downstream runtime validation remains authoritative.
 */
export function parseModelJsonObject(text: string): Record<string, unknown> {
	const trimmed = text.trim();
	if (!trimmed) throw new Error("LLM response was empty");

	try {
		return asJsonObject(JSON.parse(trimmed) as unknown);
	} catch (directError) {
		let searchFrom = 0;
		while (searchFrom < text.length) {
			const start = text.indexOf("{", searchFrom);
			if (start < 0) break;
			const end = findBalancedObjectEnd(text, start);
			if (end !== null) {
				const candidate = text.slice(start, end + 1);
				try {
					return asJsonObject(JSON.parse(candidate) as unknown);
				} catch {
					// This balanced object was not valid JSON. Try the next opening brace.
				}
			}
			searchFrom = start + 1;
		}

		const message = directError instanceof Error ? directError.message : String(directError);
		throw new Error(`LLM response did not contain a valid JSON object: ${message}`);
	}
}

function parseTopLevelJsonObjects(text: string): Record<string, unknown>[] {
	const objects: Record<string, unknown>[] = [];
	const trimmed = text.trim();
	if (!trimmed) return objects;

	try {
		objects.push(asJsonObject(JSON.parse(trimmed) as unknown));
		return objects;
	} catch {
		// Compatibility path below handles wrappers, NDJSON, SSE and concatenated objects.
	}

	let searchFrom = 0;
	while (searchFrom < text.length) {
		const start = text.indexOf("{", searchFrom);
		if (start < 0) break;
		const end = findBalancedObjectEnd(text, start);
		if (end === null) {
			searchFrom = start + 1;
			continue;
		}
		const candidate = text.slice(start, end + 1);
		try {
			objects.push(asJsonObject(JSON.parse(candidate) as unknown));
			searchFrom = end + 1;
		} catch {
			searchFrom = start + 1;
		}
	}
	return objects;
}

function readChoiceContent(envelope: Record<string, unknown>, field: "message" | "delta"): string | null {
	const choices = envelope.choices;
	if (!Array.isArray(choices) || choices.length === 0) return null;
	const choice = choices[0];
	if (typeof choice !== "object" || choice === null || Array.isArray(choice)) return null;
	const container = (choice as Record<string, unknown>)[field];
	if (typeof container !== "object" || container === null || Array.isArray(container)) return null;
	const content = (container as Record<string, unknown>).content;
	return typeof content === "string" ? content : null;
}

/**
 * Decode the HTTP body returned by an OpenAI-compatible provider.
 *
 * The OpenAI contract is one JSON object when `stream: false`, but local
 * gateways sometimes append metadata, emit NDJSON, or return SSE-like chunks
 * even for a non-streaming request. Parsing the body with `response.json()`
 * makes those otherwise usable responses fail before Chef can inspect them.
 */
export function parseOpenAICompatibleResponseBody(text: string): string {
	const objects = parseTopLevelJsonObjects(text);
	if (objects.length === 0) {
		throw new Error("OpenAI-compatible provider returned a body with no valid JSON object");
	}

	// Prefer a complete message if any envelope contains one. Search from the
	// end because some gateways append a final normalized completion envelope.
	for (let index = objects.length - 1; index >= 0; index -= 1) {
		const content = readChoiceContent(objects[index], "message");
		if (content) return content;
	}

	// Compatibility with accidental streaming/NDJSON responses.
	let streamedContent = "";
	for (const object of objects) {
		streamedContent += readChoiceContent(object, "delta") ?? "";
	}
	if (streamedContent) return streamedContent;

	const providerError = objects.find((object) => object.error !== undefined)?.error;
	if (providerError !== undefined) {
		let detail: string;
		try {
			detail = JSON.stringify(providerError);
		} catch {
			detail = String(providerError);
		}
		throw new Error(`OpenAI-compatible provider returned an error payload: ${detail.slice(0, 800)}`);
	}

	throw new Error(`OpenAI-compatible provider returned ${objects.length} JSON object(s) but no message content`);
}

function isLLMDebugEnabled(): boolean {
	return ["1", "true", "yes", "on"].includes((process.env.CHEF_LLM_DEBUG ?? "").toLowerCase());
}

function debugPreview(text: string, limit = 1200): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}

function sanitizeEndpoint(endpoint: string): string {
	try {
		const url = new URL(endpoint);
		url.username = "";
		url.password = "";
		url.search = "";
		url.hash = "";
		return url.toString();
	} catch {
		return "<invalid endpoint>";
	}
}

function llmDebug(event: string, details: Record<string, unknown>): void {
	if (!isLLMDebugEnabled()) return;
	console.error(`[chef:llm] ${event} ${JSON.stringify(details)}`);
}

// ---------------------------------------------------------------------------
// LLM Decision Provider
// ---------------------------------------------------------------------------

export class LLMDecisionProvider implements DecisionProvider {
	readonly name: string;
	#config: LLMDecisionProviderConfig;
	#client: Anthropic | null = null;
	#fallback: ScriptedDecisionProvider;

	constructor(config: LLMDecisionProviderConfig) {
		this.name = `llm-${config.provider}`;
		this.#config = {
			...config,
			timeoutMs: config.timeoutMs ?? 60_000,
			temperature: config.temperature ?? 0.2,
			maxTokens: config.maxTokens ?? 4096,
		};
		this.#fallback = new ScriptedDecisionProvider();
		this.#initializeClient();
	}

	#initializeClient(): void {
		const { provider, apiKey, baseUrl } = this.#config;
		if (provider === "anthropic") {
			this.#client = new Anthropic({
				apiKey,
				baseURL: baseUrl,
				timeout: this.#config.timeoutMs,
			});
		} else if (provider === "openai" || provider === "custom") {
			// OpenAI-compatible providers use the standard /chat/completions HTTP contract.
			this.#client = null;
		}
	}

	async proposePlan(input: PlanProposalContext): Promise<Plan | null> {
		if (!this.#client && this.#config.provider === "anthropic") {
			return this.#fallback.proposePlan(input);
		}

		const nodeTypes = this.#getNodeTypeInfos();
		const systemPrompt = this.#buildSystemPrompt(nodeTypes);
		const userPrompt = this.#buildUserPrompt(input);

		try {
			const response = await this.#callLLM(systemPrompt, userPrompt);
			return this.#parsePlan(response, input.workspaceId, input.goal);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			llmDebug("plan.error", {
				provider: this.#config.provider,
				model: this.#config.model,
				error: errorMessage,
			});
			throw new Error(`LLM plan proposal failed: ${errorMessage}`);
		}
	}

	async evaluate(taskResult: PlanTaskOutcome): Promise<Decision> {
		if (!this.#client && this.#config.provider === "anthropic") {
			return this.#fallback.evaluate(taskResult);
		}

		const prompt = `Task ${taskResult.taskId} finished with status: ${taskResult.status}.
Result summary: ${taskResult.resultSummary ?? "none"}
Error: ${taskResult.error ?? "none"}

Return a JSON object with:
{
  "summary": "concise evaluation summary",
  "status": "accepted" | "rejected"
}`;

		try {
			const response = await this.#callLLM(
				"You are a task evaluator. Return only valid JSON.",
				prompt,
			);
			const parsed = parseModelJsonObject(response);
			const accepted = parsed.status === "accepted";
			return {
				id: crypto.randomUUID(),
				workspaceId: taskResult.taskId, // best effort
				type: "task.evaluation",
				summary: typeof parsed.summary === "string" ? parsed.summary : (accepted ? "Task completed" : "Task failed"),
				payload: taskResult,
				madeBy: this.name,
				timestamp: Date.now(),
				status: accepted ? "accepted" : "rejected",
			};
		} catch {
			// On LLM failure, use simple heuristic.
			const accepted = taskResult.status === "completed";
			return {
				id: crypto.randomUUID(),
				workspaceId: taskResult.taskId,
				type: "task.evaluation",
				summary: accepted
					? `Task ${taskResult.taskId} completed${taskResult.resultSummary ? `: ${taskResult.resultSummary}` : ""}`
					: `Task ${taskResult.taskId} did not complete (status ${taskResult.status})`,
				payload: taskResult,
				madeBy: this.name,
				timestamp: Date.now(),
				status: accepted ? "accepted" : "rejected",
			};
		}
	}

	#getNodeTypeInfos(): NodeTypeInfo[] {
		return nodeRegistry.list().map((def: NodeDefinition) => ({
			type: def.type,
			category: def.category,
			label: def.label,
			description: def.description,
			inputs: def.inputs.map((port) => ({
				id: port.id,
				label: port.label,
				type: port.type,
				required: port.required,
			})),
			outputs: def.outputs.map((port) => ({
				id: port.id,
				label: port.label,
				type: port.type,
				required: port.required,
			})),
			configSchema: {},
			configDefaults: def.config.defaults(),
		}));
	}

	#buildSystemPrompt(nodeTypes: NodeTypeInfo[]): string {
		const typesList = nodeTypes
			.map(
				(nodeType) =>
					`- ${nodeType.type} (${nodeType.category}): ${nodeType.label} — ${nodeType.description}\n` +
					`  Inputs: ${nodeType.inputs.map((input) => `${input.id}${input.required ? " (required)" : ""}`).join(", ")}\n` +
					`  Outputs: ${nodeType.outputs.map((output) => `${output.id}${output.required ? " (required)" : ""}`).join(", ")}`,
			)
			.join("\n\n");

		return `You are Chef, an AI workflow planner. You decompose user goals into structured plans using the available node types.

Available node types:
${typesList}

Rules:
1. Output ONLY valid JSON matching the Plan schema.
2. Every task must use a valid node type from the list above.
3. Task IDs must be unique strings (use UUIDs).
4. Dependencies must reference other task IDs in the same plan.
5. Priority: higher numbers run first (1 = normal, 0 = last).
6. assignedTo should match a known agent type or be omitted.
7. If a task requires human approval, add approvalId (UUID).
8. Prefer linear chains; add branching only when necessary.
9. Use human.approval nodes for gating; human.input for collecting user input.
10. The plan must be executable by the runtime.`;
	}

	#buildUserPrompt(input: PlanProposalContext): string {
		const contextRefs = input.contextRefs?.length
			? `\nContext references:\n${input.contextRefs.map((ref) => `- ${ref.type}:${ref.id} (relevance ${ref.relevance})`).join("\n")}`
			: "";
		const events = input.events?.length
			? `\nRecent events:\n${input.events.slice(-5).map((event) => `- ${event.type}: ${JSON.stringify(event.payload)}`).join("\n")}`
			: "";

		return `Goal: ${input.goal}${contextRefs}${events}

Return a Plan with tasks that achieve this goal.`;
	}

	async #callLLM(systemPrompt: string, userPrompt: string): Promise<string> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.#config.timeoutMs);
		try {
			if (this.#config.provider === "openai" || this.#config.provider === "custom") {
				const base = (this.#config.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
				const endpoint = `${base}/chat/completions`;
				const requestBody = {
					model: this.#config.model,
					temperature: this.#config.temperature,
					max_tokens: this.#config.maxTokens ?? 4096,
					stream: false,
					response_format: { type: "json_object" },
					messages: [
						{ role: "system", content: systemPrompt },
						{ role: "user", content: `${userPrompt}\nReturn only valid JSON.` },
					],
				};
				llmDebug("request", {
					provider: this.#config.provider,
					model: this.#config.model,
					endpoint: sanitizeEndpoint(endpoint),
					timeoutMs: this.#config.timeoutMs,
					systemPromptChars: systemPrompt.length,
					userPromptChars: userPrompt.length,
				});
				const response = await fetch(endpoint, {
					method: "POST",
					signal: controller.signal,
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${this.#config.apiKey}`,
					},
					body: JSON.stringify(requestBody),
				});
				const responseBody = await response.text();
				llmDebug("response", {
					provider: this.#config.provider,
					model: this.#config.model,
					endpoint: sanitizeEndpoint(endpoint),
					status: response.status,
					contentType: response.headers.get("content-type"),
					bodyChars: responseBody.length,
					bodyPreview: debugPreview(responseBody),
				});
				if (!response.ok) {
					throw new Error(`OpenAI-compatible request failed: HTTP ${response.status} ${debugPreview(responseBody, 800)}`);
				}
				const content = parseOpenAICompatibleResponseBody(responseBody);
				llmDebug("content", {
					provider: this.#config.provider,
					model: this.#config.model,
					contentChars: content.length,
					contentPreview: debugPreview(content),
				});
				return content;
			}

			if (!this.#client) throw new Error("LLM client not initialized");
			const message = await this.#client.messages.create({
				model: this.#config.model,
				max_tokens: this.#config.maxTokens ?? 4096,
				temperature: this.#config.temperature,
				system: systemPrompt,
				messages: [{ role: "user", content: userPrompt }],
				tools: [{
					name: "propose_plan",
					description: "Propose a structured workflow plan",
					input_schema: {
						type: "object",
						properties: {
							goal: { type: "string" },
							tasks: {
								type: "array",
								items: {
									type: "object",
									properties: {
										id: { type: "string" },
										title: { type: "string" },
										description: { type: "string" },
										dependencies: { type: "array", items: { type: "string" } },
										priority: { type: "number" },
										assignedTo: { type: "string" },
										approvalId: { type: "string" },
									},
									required: ["id", "title", "description", "dependencies", "priority"],
									additionalProperties: false,
								},
							},
						},
						required: ["goal", "tasks"],
						additionalProperties: false,
					},
				}],
				tool_choice: { type: "tool", name: "propose_plan" },
			});
			const toolUse = message.content.find((content) => content.type === "tool_use");
			if (!toolUse) throw new Error("LLM did not call propose_plan tool");
			return JSON.stringify(toolUse.input);
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") {
				throw new Error(`LLM request timed out after ${this.#config.timeoutMs}ms`);
			}
			throw error;
		} finally {
			clearTimeout(timeout);
		}
	}

	#parsePlan(jsonStr: string, workspaceId: WorkspaceId, goal: string): Plan {
		const parsed = parseModelJsonObject(jsonStr);
		const rawTasks = parsed.tasks;

		if (!Array.isArray(rawTasks)) {
			throw new Error("Invalid plan: missing tasks array");
		}

		const tasks: PlanTask[] = rawTasks.map((value: unknown) => {
			const task = value as Record<string, unknown>;
			return {
				id: String(task.id ?? crypto.randomUUID()),
				title: String(task.title ?? "Untitled"),
				description: String(task.description ?? ""),
				dependencies: Array.isArray(task.dependencies) ? task.dependencies.map(String) : [],
				priority: typeof task.priority === "number" ? task.priority : 0,
				assignedTo: task.assignedTo ? String(task.assignedTo) : undefined,
				approvalId: task.approvalId ? String(task.approvalId) : undefined,
			};
		});

		for (const task of tasks) {
			if (!task.assignedTo) continue;
			const definition = nodeRegistry.get(task.assignedTo);
			if (!definition) {
				throw new Error(`Unknown node type assigned: ${task.assignedTo}`);
			}
		}

		const createdAt = Date.now();
		return {
			id: crypto.randomUUID(),
			workspaceId,
			goal,
			status: "proposed",
			tasks,
			taskIds: tasks.map((task) => task.id),
			createdAt,
		};
	}
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

export interface LLMProviderConfig {
	provider: string | null;
	apiKey: string | null;
	model: string;
	baseUrl?: string;
	timeoutMs?: number;
}

/** Read the LLM decision-provider config from env (single source of truth for env var names). */
export function readLLMProviderConfig(): LLMProviderConfig {
	const provider = process.env.CHEF_PROVIDER?.toLowerCase() ?? null;
	const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY ?? process.env.CHEF_API_KEY ?? null;
	const model = process.env.CHEF_MODEL ?? "claude-3-5-sonnet-20241022";
	const baseUrl = process.env.CHEF_BASE_URL;
	const timeoutMs = process.env.CHEF_TIMEOUT_MS ? Number(process.env.CHEF_TIMEOUT_MS) : undefined;
	return { provider, apiKey, model, baseUrl, timeoutMs };
}

export function createLLMDecisionProvider(): DecisionProvider | null {
	const { provider, apiKey, model, baseUrl, timeoutMs } = readLLMProviderConfig();

	if (!provider || !apiKey) {
		return null; // No provider configured → caller uses ScriptedDecisionProvider
	}

	if (!["anthropic", "openai", "custom"].includes(provider)) {
		throw new Error(`Invalid CHEF_PROVIDER: ${provider}. Must be anthropic, openai, or custom`);
	}

	return new LLMDecisionProvider({
		provider: provider as "anthropic" | "openai" | "custom",
		apiKey,
		model,
		baseUrl,
		timeoutMs,
	});
}
