import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sessionId = process.env.CHEF_SESSION_ID;
if (!sessionId) throw new Error("CHEF_SESSION_ID is required");
const prompt = process.argv[2] ?? "";
const metadata = {
  runCommand: "npm run dev",
  verification: prompt.includes("failed verification")
    ? "5 tests passed, 1 failed"
    : "npm test passed (12 tests)",
  ...(prompt.includes("explicit result location")
    ? { resultLocation: "file:///D:/Chef%20Output/todo-explicit" }
    : {}),
};
const envelope = {
  version: 1,
  id: randomUUID(),
  kind: "artifact",
  from: "process",
  payload: {
    type: "result",
    name: "specialized-result",
    uri: "file:///C:/Work/Chef%20Projects/todo-app",
    metadata,
  },
  timestamp: Date.now(),
};
const outbox = join(tmpdir(), "chef-sideband", sessionId, "outbox");
mkdirSync(outbox, { recursive: true });
writeFileSync(join(outbox, `${envelope.id}.json`), JSON.stringify(envelope));
process.stdout.write("SPECIALIZED-ARTIFACT-WRITTEN\n");
setTimeout(() => process.exit(0), 500);
