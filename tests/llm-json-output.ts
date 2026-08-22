import { strict as assert } from "node:assert";
import { parseModelJsonObject } from "../src/orchestrator/llm-decision-provider.ts";

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

console.log("llm-json-output: ok — wrapped provider JSON is tolerated without repairing malformed JSON");
