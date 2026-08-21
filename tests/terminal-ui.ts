import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

const canvas = await readFile(new URL("../web/src/BlueprintCanvas.tsx", import.meta.url), "utf8");
const terminalView = await readFile(new URL("../web/src/TerminalView.tsx", import.meta.url), "utf8");

assert.match(canvas, /const \[open, setOpen\] = useState\(true\)/, "terminal surface should open by default");
assert.match(canvas, /task\?\.workflowNodeId === "tool\.terminal"/, "terminal detection should use the durable task type");
assert.match(canvas, /Starting default terminal…/, "terminal node should show launch feedback before the session is visible");
assert.match(canvas, /nodrag nopan nowheel h-\[300px\]/, "terminal viewport should opt out of canvas gestures");
assert.match(terminalView, /wb-terminal-view nodrag nopan nowheel/, "xterm should opt out of React Flow gestures");
assert.match(terminalView, /onPointerDown=\{\(event\) => event\.stopPropagation\(\)\}/, "terminal pointer input should not start node interaction");
assert.match(terminalView, /onClick=\{\(event\) => event\.stopPropagation\(\)\}/, "terminal clicks should not select the canvas node");

console.log("terminal-ui: ok — terminal opens by default and owns its pointer input");
