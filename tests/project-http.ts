import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createProjectServer, findLinuxDirectoryPicker } from "../src/server/project-http.ts";
import { shouldRejectOtherProjectRuntime } from "../scripts/launcher-policy.mjs";
import type { ChefRuntime } from "../src/main.ts";

assert.equal(shouldRejectOtherProjectRuntime({
  existingProjectPath: "/home/jessen/brain",
  currentProjectPath: "/home/jessen/chef",
  restart: true,
  platform: "linux",
}), false, "--restart must be allowed to replace a Chef runtime serving another project");
assert.equal(shouldRejectOtherProjectRuntime({
  existingProjectPath: "/home/jessen/brain",
  currentProjectPath: "/home/jessen/chef",
  restart: false,
  platform: "linux",
}), true, "without --restart, Chef must refuse to steal another project's runtime");
assert.equal(shouldRejectOtherProjectRuntime({
  existingProjectPath: "C:\\Work\\Chef",
  currentProjectPath: "c:\\work\\chef",
  restart: false,
  platform: "win32",
}), false, "Windows project comparison must remain case-insensitive");

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

  const selectedCurrent = await fetch(`${origin}/api/project/open`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: current }),
  });
  assert.equal(selectedCurrent.status, 200, "selecting the active project must clearly succeed without a relaunch");
  const selectedCurrentBody = await selectedCurrent.json() as { ok?: boolean; data?: { path?: string; current?: boolean } };
  assert.equal(selectedCurrentBody.ok, true);
  assert.equal(selectedCurrentBody.data?.path, current);
  assert.equal(selectedCurrentBody.data?.current, true, "project selection response must explicitly confirm the project is current");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(opened, null, "selecting the already-active project must not trigger a runtime relaunch");

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
