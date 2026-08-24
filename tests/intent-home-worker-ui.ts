import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

const home = await readFile(new URL("../web/src/IntentHome.tsx", import.meta.url), "utf8");

assert.match(home, /\{task\.assignedTo && \(/, "Simple Mode should show a worker only when a real Task assignee exists");
assert.match(home, /Worker · \{task\.assignedTo\}/, "current Mission task rows should render the durable assigned worker in product language");
assert.doesNotMatch(home, /Worker · \{task\.(sessionId|harness|pid)\}/, "worker visibility must not expose runtime implementation details");
