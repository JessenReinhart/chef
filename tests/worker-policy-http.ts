import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createHttpServer } from "../src/server/http-server.ts";
import { currentWorkerPolicy } from "../src/runtime/worker-policy.ts";

const detections = [
  { id: "claude-code", name: "Claude Code", type: "claude-code", command: "claude", available: true, taskCapable: true },
  { id: "omp", name: "OMP", type: "omp", command: "omp", available: false, taskCapable: true },
];
const observed: unknown[] = [];
const runtime = {
  workspaceId: "worker-policy-http",
  specializedHarnesses: {
    detections: () => detections.map((item) => ({ ...item })),
  },
  async sendChatMessage(message: string) {
    observed.push({ message, policy: currentWorkerPolicy() });
    return { workspaceId: "worker-policy-http", taskIds: ["task-1"], report: "ok", ok: true };
  },
} as never;

const server = createHttpServer(runtime);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address() as AddressInfo;
const root = `http://127.0.0.1:${address.port}`;

async function post(body: unknown): Promise<Response> {
  return fetch(`${root}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

try {
  const invalid = await post({ message: "hello", workerPolicy: { mode: "random" } });
  assert.equal(invalid.status, 400);

  const unavailable = await post({ message: "hello", workerPolicy: { mode: "locked", workerId: "omp" } });
  assert.equal(unavailable.status, 409);
  assert.match(((await unavailable.json()) as { error: string }).error, /Required worker is not available/);
  assert.equal(observed.length, 0, "locked unavailable worker must fail before Mission launch");

  const required = await post({ message: "use Claude", workerPolicy: { mode: "locked", workerId: "claude-code" } });
  assert.equal(required.status, 200);
  assert.deepEqual(observed.at(-1), {
    message: "use Claude",
    policy: { mode: "locked", workerId: "claude-code" },
  });

  const automatic = await post({ message: "auto please" });
  assert.equal(automatic.status, 200);
  assert.deepEqual(observed.at(-1), { message: "auto please", policy: { mode: "auto" } });
  assert.deepEqual(currentWorkerPolicy(), { mode: "auto" }, "HTTP policy must not escape request scope");

  console.log("worker-policy-http: ok — validation, fail-fast locking, and request scope enforced");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
