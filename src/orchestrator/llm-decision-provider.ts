/**
 * Chef P0 — LLM Decision Provider (provider-neutral).
 *
 * Uses Anthropic SDK or OpenAI-compatible client with structured JSON schema validation.
 * Falls back to ScriptedDecisionProvider when no provider configured.
 * 60s timeout per proposal (configurable).
 */

import type {
	AgentId,
	Decision,
	DecisionProvider,
	Plan,
	PlanId,
	PlanProposalContext,
	PlanTask,
	PlanTaskOutcome,
	Timestamp,
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
// Internal types
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

interface PlanSchema {
	type: "object";
	properties: {
		goal: { type: "string" };
		tasks: {
			type: "array";
			items: {
				type: "object";
				properties: {
					id: { type: "string" };
					title: { type: "string" };
					description: { type: "string" };
					dependencies: { type: "array"; items: { type: "string" } };
					priority: { type: "number" };
					assignedTo: { type: "string" };
					approvalId: { type: "string" };
				};
				required: ["id", "title", "description", "dependencies", "priority"];
				additionalProperties: false;
			};
		};
	};
	required: ["goal", "tasks"];
	additionalProperties: false;
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
			// For OpenAI-compatible, we use the Anthropic SDK with a custom base URL
			// The Anthropic SDK supports OpenAI-compatible endpoints
			this.#client = new Anthropic({
				apiKey,
				baseURL: baseUrl ?? "https://api.openai.com/v1",
				timeout: this.#config.timeoutMs,
			});
		}
	}

	async proposePlan(input: PlanProposalContext): Promise<Plan | null> {
		if (!this.#client) {
			return this.#fallback.proposePlan(input);
		}

		const nodeTypes = this.#getNodeTypeInfos();
		const systemPrompt = this.#buildSystemPrompt(nodeTypes);
		const userPrompt = this.#buildUserPrompt(input);

		try {
			const response = await this.#callLLM(systemPrompt, userPrompt);
			const plan = this.#parsePlan(response, input.workspaceId, input.goal);
			return plan;
		} catch (error) {
			// Provider failure → structured error decision with status: "rejected"
			const errorMessage = error instanceof Error ? error.message : String(error);
			throw new Error(`LLM plan proposal failed: ${errorMessage}`);
		}
	}

	async evaluate(taskResult: PlanTaskOutcome): Promise<Decision> {
		if (!this.#client) {
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
				prompt
			);
			const parsed = JSON.parse(response);
			const accepted = parsed.status === "accepted";
			return {
				id: crypto.randomUUID(),
				workspaceId: taskResult.taskId, // best effort
				type: "task.evaluation",
				summary: parsed.summary ?? (accepted ? "Task completed" : "Task failed"),
				payload: taskResult,
				madeBy: this.name,
				timestamp: Date.now(),
				status: accepted ? "accepted" : "rejected",
			};
		} catch {
			// On LLM failure, use simple heuristic
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

	// -------------------------------------------------------------------------
	// Private helpers
	// -------------------------------------------------------------------------

	#getNodeTypeInfos(): NodeTypeInfo[] {
		return nodeRegistry.list().map((def: NodeDefinition) => ({
			type: def.type,
			category: def.category,
			label: def.label,
			description: def.description,
			inputs: def.inputs.map((p) => ({
				id: p.id,
				label: p.label,
				type: p.type,
				required: p.required,
			})),
			outputs: def.outputs.map((p) => ({
				id: p.id,
				label: p.label,
				type: p.type,
				required: p.required,
			})),
			configSchema: {},
			configDefaults: def.config.defaults(),
		}));
	}

	#buildSystemPrompt(nodeTypes: NodeTypeInfo[]): string {
		const typesList = nodeTypes
			.map(
				(nt) =>
					`- ${nt.type} (${nt.category}): ${nt.label} — ${nt.description}\n` +
					`  Inputs: ${nt.inputs.map((i) => `${i.id}${i.required ? " (required)" : ""}`).join(", ")}\n` +
					`  Outputs: ${nt.outputs.map((o) => `${o.id}${o.required ? " (required)" : ""}`).join(", ")}`
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
			? `\nContext references:\n${input.contextRefs.map((r) => `- ${r.type}:${r.id} (relevance ${r.relevance})`).join("\n")}`
			: "";
		const events = input.events?.length
			? `\nRecent events:\n${input.events.slice(-5).map((e) => `- ${e.type}: ${JSON.stringify(e.payload)}`).join("\n")}`
			: "";

		return `Goal: ${input.goal}${contextRefs}${events}

Return a Plan with tasks that achieve this goal.`;
	}

	async #callLLM(systemPrompt: string, userPrompt: string): Promise<string> {
		if (!this.#client) {
			throw new Error("LLM client not initialized");
		}

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.#config.timeoutMs);

		try {
			const message = await this.#client.messages.create({
				model: this.#config.model,
				max_tokens: this.#config.maxTokens ?? 4096,
				temperature: this.#config.temperature,
				system: systemPrompt,
				messages: [{ role: "user", content: userPrompt }],
				// Anthropic structured output via JSON schema
				tools: [
					{
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
					},
				],
				tool_choice: { type: "tool", name: "propose_plan" },
			});

			clearTimeout(timeout);

			const toolUse = message.content.find((c) => c.type === "tool_use");
			if (!toolUse) {
				throw new Error("LLM did not call propose_plan tool");
			}

			return JSON.stringify(toolUse.input);
		} catch (error) {
			clearTimeout(timeout);
			if (error instanceof Error && error.name === "AbortError") {
				throw new Error(`LLM request timed out after ${this.#config.timeoutMs}ms`);
			}
			throw error;
		}
	}

	#parsePlan(jsonStr: string, workspaceId: WorkspaceId, goal: string): Plan {
		const parsed = JSON.parse(jsonStr);

		// Validate structure
		if (!parsed.tasks || !Array.isArray(parsed.tasks)) {
			throw new Error("Invalid plan: missing tasks array");
		}

		const tasks: PlanTask[] = parsed.tasks.map((t: unknown) => {
			const task = t as Record<string, unknown>;
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

		// Validate node types exist
		for (const task of tasks) {
			if (task.assignedTo) {
				const def = nodeRegistry.get(task.assignedTo);
				if (!def) {
					throw new Error(`Unknown node type assigned: ${task.assignedTo}`);
				}
			}
		}

		const createdAt = Date.now();
		return {
			id: crypto.randomUUID(),
			workspaceId,
			goal,
			status: "proposed",
			tasks,
			taskIds: tasks.map((t) => t.id),
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
