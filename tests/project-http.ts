import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createProjectServer, findLinuxDirectoryPicker } from "../src/server/project-http.ts";
import type { ChefRuntime } from "../src/main.ts";

const zenityPicker = await findLinuxDirectoryPicker(async (command) => command === "zenity");
assert.equal(zenityPicker?.command, "zenity");
assert.deepEqual(zenityPicker?.args.slice(0, 2), ["--file-selection", "--directory"]);

const kdialogPicker = await findLinuxDirectoryPicker(async (command) => command === "kdialog");
assert.equal(kdialogPicker?.command, "kdialog");
assert.equal(await findLinuxDirectoryPicker(async () => false), null);

const dir = await mkdtemp(join(tmpdir(), "chef-project-http-"));
const current = join(dir, "current");
const next = join(dir, "next");
const recents = join(dir, "state", "recent.json");
await mkdir(current);
await mkdir(next);
let opened: string | null = null;

const runtime = { projectDir: current } as ChefRuntime;
const base = createServer((_req, res) => { res.writeHead(418); res.end("base"); });
const server = createProjectServer(runtime, base, {
  recentProjectsPath: recents,
  pickDirectory: async () => next,
  canPickDirectory: async () => true,
  onOpenProject: async (path) => { opened = path; },
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");
const origin = `http://127.0.0.1:${address.port}`;

try {
  const state = await fetch(`${origin}/api/project`).then((response) => response.json()) as { data: { path: string; recent: unknown[]; nativePicker: boolean } };
  assert.equal(state.data.path, current);
  assert.deepEqual(state.data.recent, []);
  assert.equal(state.data.nativePicker, true);

  const invalid = await fetch(`${origin}/api/project/open`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: join(dir, "missing") }),
  });
  assert.equal(invalid.status, 400);

  const picked = await fetch(`${origin}/api/project/pick`, { method: "POST" });
  assert.equal(picked.status, 202);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(opened, next);

  const remembered = JSON.parse(await readFile(recents, "utf8")) as Array<{ path: string }>;
  assert.equal(remembered[0]?.path, next);

  const fallback = await fetch(`${origin}/anything`);
  assert.equal(fallback.status, 418);
  console.log("project-http: ok");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
}
