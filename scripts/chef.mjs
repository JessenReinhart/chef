import { spawn, spawnSync } from "node:child_process";
import { access, readdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WEB = resolve(ROOT, "web");
const DIST_INDEX = resolve(WEB, "dist", "index.html");
const PORT = Number(process.env.CHEF_PORT ?? 4321);
const URL = `http://127.0.0.1:${PORT}`;
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const launcherArgs = new Set(process.argv.slice(2));

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

async function runtimeProjectPath() {
  try {
    const response = await fetch(`${URL}/api/project`, { signal: AbortSignal.timeout(800) });
    if (!response.ok) return null;
    const body = await response.json();
    return body?.ok === true && typeof body?.data?.path === "string" ? body.data.path : null;
  } catch {
    return null;
  }
}

async function runtimeIsReady() {
  return (await runtimeProjectPath()) !== null;
}

function normalizedPath(path) {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function findListeningPids() {
  if (process.platform === "win32") {
    const result = spawnSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8", windowsHide: true });
    if (result.error || result.status !== 0) return [];
    const pids = new Set();
    for (const line of result.stdout.split(/\r?\n/)) {
      const columns = line.trim().split(/\s+/);
      if (columns.length < 5 || columns[0].toUpperCase() !== "TCP") continue;
      const localAddress = columns[1];
      const state = columns[3]?.toUpperCase();
      const pid = Number(columns[4]);
      if (state !== "LISTENING" || !localAddress?.endsWith(`:${PORT}`) || !Number.isInteger(pid) || pid <= 0) continue;
      pids.add(pid);
    }
    return [...pids];
  }

  const candidates = [
    ["lsof", [`-tiTCP:${PORT}`, "-sTCP:LISTEN"]],
    ["fuser", [`${PORT}/tcp`]],
  ];
  for (const [command, args] of candidates) {
    const result = spawnSync(command, args, { encoding: "utf8" });
    if (result.error || result.status !== 0) continue;
    const pids = [...new Set(`${result.stdout ?? ""} ${result.stderr ?? ""}`.match(/\b\d+\b/g)?.map(Number) ?? [])]
      .filter((pid) => Number.isInteger(pid) && pid > 0);
    if (pids.length > 0) return pids;
  }
  return [];
}

async function waitForRuntimeToStop(timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await runtimeIsReady())) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  return false;
}

async function terminateExistingRuntime() {
  const pids = findListeningPids();
  if (pids.length === 0) {
    fail(`Could not identify the Chef process listening on port ${PORT}. Stop it manually, then run Chef again.`);
  }

  info(`Stopping existing Chef runtime (PID${pids.length > 1 ? "s" : ""} ${pids.join(", ")})...`);
  if (process.platform === "win32") {
    for (const pid of pids) {
      const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      if (result.error || result.status !== 0) fail(`Could not terminate Chef process ${pid}.`);
    }
  } else {
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGTERM");
      } catch (error) {
        if (error?.code !== "ESRCH") fail(`Could not terminate Chef process ${pid}: ${error.message}`);
      }
    }
  }

  if (await waitForRuntimeToStop(3_000)) return;

  if (process.platform !== "win32") {
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") fail(`Could not force-stop Chef process ${pid}: ${error.message}`);
      }
    }
  }

  if (!(await waitForRuntimeToStop(2_000))) {
    fail(`Chef is still responding at ${URL} after the old process was terminated.`);
  }
}

async function shouldRestartExistingRuntime() {
  if (launcherArgs.has("--restart")) return true;
  if (launcherArgs.has("--reuse")) return false;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    info("Keeping the existing runtime because this launch is non-interactive. Use --restart to replace it.");
    return false;
  }

  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await readline.question("[Chef] Terminate the old process and start the current version? (Y/n) ")).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    readline.close();
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

if (launcherArgs.has("--restart") && launcherArgs.has("--reuse")) {
  fail("Use either --restart or --reuse, not both.");
}

const existingProjectPath = await runtimeProjectPath();
if (existingProjectPath !== null) {
  info(`Chef is already running at ${URL}`);
  if (normalizedPath(existingProjectPath) !== normalizedPath(ROOT)) {
    fail(`Port ${PORT} is used by a Chef runtime for another project: ${existingProjectPath}`);
  }

  if (await shouldRestartExistingRuntime()) {
    await terminateExistingRuntime();
  } else {
    openBrowser();
    process.exit(0);
  }
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
