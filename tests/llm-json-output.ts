import { strict as assert } from "node:assert";
import {
	parseModelJsonObject,
	parseOpenAICompatibleResponseBody,
} from "../src/orchestrator/llm-decision-provider.ts";

const plan = {
	goal: "Fix the bug",
	tasks: [{
		id: "task-1",
		title: "Inspect",
		description: "Inspect the failure",
		dependencies: [],
		priority: 1,
	}],
};
const json = JSON.stringify(plan);

assert.deepEqual(parseModelJsonObject(json), plan, "clean JSON should parse unchanged");

assert.deepEqual(
	parseModelJsonObject(`${json}\nPlan ready. I will execute these steps next.`),
	plan,
	"valid JSON followed by provider prose should still parse",
);

assert.deepEqual(
	parseModelJsonObject(`Here is the requested plan:\n\`\`\`json\n${json}\n\`\`\``),
	plan,
	"markdown-fenced JSON should still parse",
);

const withBracesInString = {
	goal: "Inspect {config} without confusing the parser",
	tasks: [],
};
assert.deepEqual(
	parseModelJsonObject(`prefix ${JSON.stringify(withBracesInString)} suffix`),
	withBracesInString,
	"braces inside JSON strings must not end the object early",
);

assert.throws(
	() => parseModelJsonObject("not json at all"),
	/valid JSON object/,
	"responses without JSON must still fail closed",
);

assert.throws(
	() => parseModelJsonObject("```json\n{tasks: nope}\n```"),
	/valid JSON object/,
	"malformed JSON must not be repaired or accepted",
);

const completionEnvelope = JSON.stringify({
	id: "chatcmpl-test",
	choices: [{ message: { role: "assistant", content: json } }],
});
assert.equal(
	parseOpenAICompatibleResponseBody(completionEnvelope),
	json,
	"normal OpenAI-compatible completion responses should return message content",
);

const appendedMetadata = `${completionEnvelope}\n${JSON.stringify({ debug: { elapsedMs: 12 } })}`;
assert.throws(
	() => JSON.parse(appendedMetadata),
	/JSON/,
	"fixture must reproduce the response.json failure from trailing JSON",
);
assert.equal(
	parseOpenAICompatibleResponseBody(appendedMetadata),
	json,
	"a valid completion followed by gateway metadata must remain usable",
);

const sseLikeBody = [
	`data: ${JSON.stringify({ choices: [{ delta: { content: "hello " } }] })}`,
	`data: ${JSON.stringify({ choices: [{ delta: { content: "world" } }] })}`,
	"data: [DONE]",
].join("\n\n");
assert.equal(
	parseOpenAICompatibleResponseBody(sseLikeBody),
	"hello world",
	"accidental SSE/streaming chunks should be reassembled when the gateway ignores stream=false",
);

assert.throws(
	() => parseOpenAICompatibleResponseBody("gateway returned plain text"),
	/no valid JSON object/,
	"transport bodies without any JSON must still fail closed",
);

console.log("llm-json-output: ok — model JSON and nonstandard OpenAI-compatible transport wrappers are tolerated");
