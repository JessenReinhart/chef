import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { buildHarnessReadiness, createHarnessReadinessServer } from "../src/server/harness-readiness-http.ts";

const detections = [
  { id: "claude-code", name: "Claude Code", type: "claude-code", command: "claude", available: true },
  { id: "omp", name: "OMP", type: "omp", command: "omp", available: false },
  { id: "generic", name: "Generic Terminal", type: "generic", command: "/bin/sh", available: true },
];

const projected = buildHarnessReadiness(detections);
assert.deepEqual(projected, [
  { ...detections[0], kind: "cli" },
  { ...detections[1], kind: "cli" },
  { id: "generic", name: "Generic Terminal", type: "generic", command: "/bin/sh", available: true, kind: "generic" },
]);
assert.deepEqual(
  buildHarnessReadiness(detections.slice(0, 2)).at(-1),
  { id: "generic", name: "Generic Terminal", type: "generic", command: null, available: true, kind: "generic" },
  "readiness keeps the generic fallback for older runtime snapshots",
);

const runtime = {
  specializedHarnesses: {
    detections() {
      return detections.map((detection) => ({ ...detection }));
    },
  },
} as never;
const base = createServer((_req, res) => { res.writeHead(418); res.end("base"); });
const server = createHarnessReadinessServer(runtime, base);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address() as AddressInfo;
const root = `http://127.0.0.1:${address.port}`;
try {
  const response = await fetch(`${root}/api/harnesses/readiness`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { ok: boolean; data: typeof projected };
  assert.equal(body.ok, true);
  assert.deepEqual(body.data, projected);
  assert.equal((await fetch(`${root}/unrelated`)).status, 418, "wrapper preserves base handler");
  console.log("harness-readiness-http: ok — detected CLI and terminal readiness are exposed");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}