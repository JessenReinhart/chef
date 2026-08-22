import { spawn, spawnSync } from "node:child_process";
import { access, readdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WEB = resolve(ROOT, "web");
const DIST_INDEX = resolve(WEB, "dist", "index.html");
const PORT = Number(process.env.CHEF_PORT ?? 4321);
const URL = `http://127.0.0.1:${PORT}`;
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function info(message) {
  console.log(`[Chef] ${message}`);
}

function fail(message) {
  console.error(`\n[Chef] ${message}`);
  process.exit(1);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function run(command, args, label) {
  info(label);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) fail(`${label} failed: ${result.error.message}`);
  if (result.status !== 0) fail(`${label} failed with exit code ${result.status ?? "unknown"}.`);
}

async function newestMtime(path) {
  const entry = await stat(path);
  if (!entry.isDirectory()) return entry.mtimeMs;
  let newest = entry.mtimeMs;
  for (const child of await readdir(path)) {
    newest = Math.max(newest, await newestMtime(resolve(path, child)));
  }
  return newest;
}

async function webBuildIsStale() {
  if (!(await exists(DIST_INDEX))) return true;
  const builtAt = (await stat(DIST_INDEX)).mtimeMs;
  const inputs = [
    resolve(WEB, "src"),
    resolve(WEB, "index.html"),
    resolve(WEB, "package.json"),
    resolve(WEB, "package-lock.json"),
    resolve(WEB, "vite.config.ts"),
  ];
  for (const input of inputs) {
    if (await exists(input) && await newestMtime(input) > builtAt) return true;
  }
  return false;
}

async function runtimeIsReady() {
  try {
    const response = await fetch(`${URL}/api/project`, { signal: AbortSignal.timeout(800) });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.ok === true && typeof body?.data?.path === "string";
  } catch {
    return false;
  }
}

function openBrowser() {
  if (process.env.CHEF_NO_OPEN === "1") {
    info(`Open ${URL} in your browser.`);
    return;
  }

  try {
    let child;
    if (process.platform === "win32") {
      child = spawn("cmd", ["/c", "start", "", URL], { detached: true, stdio: "ignore", windowsHide: true });
    } else if (process.platform === "darwin") {
      child = spawn("open", [URL], { detached: true, stdio: "ignore" });
    } else {
      child = spawn("xdg-open", [URL], { detached: true, stdio: "ignore" });
    }
    child.unref();
  } catch {
    info(`Open ${URL} in your browser.`);
  }
}

async function waitForRuntime(child, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    if (await runtimeIsReady()) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  return false;
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (!Number.isFinite(nodeMajor) || nodeMajor < 24) {
  fail(`Node.js 24 or later is required. You are running ${process.version}.`);
}

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65_535) {
  fail(`CHEF_PORT must be between 1 and 65535 (received ${process.env.CHEF_PORT}).`);
}

if (await runtimeIsReady()) {
  info(`Chef is already running at ${URL}`);
  openBrowser();
  process.exit(0);
}

if (!(await exists(resolve(ROOT, "node_modules", "node-pty", "package.json")))) {
  run(npm, ["install"], "Installing runtime dependencies for the first launch...");
}

if (!(await exists(resolve(WEB, "node_modules", "vite", "package.json")))) {
  run(npm, ["--prefix", "web", "install"], "Installing web dependencies for the first launch...");
}

if (await webBuildIsStale()) {
  run(npm, ["--prefix", "web", "run", "build"], "Building the Chef web app...");
}

info("Starting the local runtime...");
const server = spawn(process.execPath, ["--experimental-strip-types", "src/server/index.ts"], {
  cwd: ROOT,
  stdio: "inherit",
  env: process.env,
});

server.on("error", (error) => fail(`Could not start Chef: ${error.message}`));
server.on("exit", (code) => {
  process.exitCode = code ?? 0;
});

if (await waitForRuntime(server)) {
  info(`Ready at ${URL}`);
  openBrowser();
} else if (server.exitCode === null) {
  info(`Chef is still starting. Open ${URL} when the runtime is ready.`);
} else if (server.exitCode !== 0) {
  console.error(`[Chef] Runtime exited with code ${server.exitCode}.`);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    if (server.exitCode === null) server.kill(signal);
  });
}
