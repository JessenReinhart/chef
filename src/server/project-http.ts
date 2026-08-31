import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, resolve, win32 } from "node:path";
import { promisify } from "node:util";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ChefRuntime } from "../main.ts";

const execFileAsync = promisify(execFile);
type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;

export interface RecentProject {
  path: string;
  name: string;
  openedAt: number;
}

export interface ProjectServerOptions {
  recentProjectsPath?: string;
  pickDirectory?: () => Promise<string | null>;
  canPickDirectory?: () => boolean | Promise<boolean>;
  onOpenProject: (path: string) => void | Promise<void>;
}

export interface DirectoryPickerCommand {
  command: string;
  args: string[];
}

type CommandExists = (command: string) => Promise<boolean>;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => { raw += chunk.toString("utf8"); });
    req.on("end", () => {
      try { resolveBody(raw ? JSON.parse(raw) : {}); }
      catch (error) { reject(error); }
    });
    req.on("error", reject);
  });
}

async function validateDirectory(input: string): Promise<string> {
  const path = resolve(input);
  const info = await stat(path);
  if (!info.isDirectory()) throw new Error("project path must be a directory");
  await access(path);
  return path;
}

export function isSameProjectPath(left: string, right: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "win32") return win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase();
  return resolve(left) === resolve(right);
}

async function readRecentProjects(path: string): Promise<RecentProject[]> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is RecentProject => Boolean(
      item && typeof item === "object"
      && typeof (item as RecentProject).path === "string"
      && typeof (item as RecentProject).name === "string"
      && typeof (item as RecentProject).openedAt === "number",
    ));
  } catch {
    return [];
  }
}

async function rememberProject(storagePath: string, projectPath: string): Promise<RecentProject[]> {
  const recent = await readRecentProjects(storagePath);
  const next: RecentProject[] = [
    { path: projectPath, name: basename(projectPath) || projectPath, openedAt: Date.now() },
    ...recent.filter((item) => item.path !== projectPath),
  ].slice(0, 10);
  await mkdir(dirname(storagePath), { recursive: true });
  await writeFile(storagePath, JSON.stringify(next, null, 2), "utf8");
  return next;
}

async function commandExistsOnPath(command: string): Promise<boolean> {
  const pathValue = process.env.PATH;
  if (!pathValue) return false;
  for (const entry of pathValue.split(delimiter)) {
    if (!entry) continue;
    try {
      await access(resolve(entry, command), fsConstants.X_OK);
      return true;
    } catch {
      // Keep looking through PATH.
    }
  }
  return false;
}

export async function findLinuxDirectoryPicker(commandExists: CommandExists = commandExistsOnPath): Promise<DirectoryPickerCommand | null> {
  const candidates: DirectoryPickerCommand[] = [
    {
      command: "zenity",
      args: ["--file-selection", "--directory", "--title=Open a project in Chef"],
    },
    {
      command: "kdialog",
      args: ["--getexistingdirectory", homedir(), "--title", "Open a project in Chef"],
    },
    {
      command: "yad",
      args: ["--file-selection", "--directory", "--title=Open a project in Chef"],
    },
  ];

  for (const candidate of candidates) {
    if (await commandExists(candidate.command)) return candidate;
  }
  return null;
}

function pickerWasCancelled(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; stderr?: unknown };
  return candidate.code === 1 && (candidate.stderr === undefined || String(candidate.stderr).trim() === "");
}

async function defaultCanPickDirectory(): Promise<boolean> {
  if (process.platform === "win32") return true;
  if (process.platform === "linux") return (await findLinuxDirectoryPicker()) !== null;
  return false;
}

async function defaultPickDirectory(): Promise<string | null> {
  if (process.platform === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$dialog.Description = 'Open a project in Chef'",
      "$dialog.ShowNewFolderButton = $true",
      "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {",
      "  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
      "  Write-Output $dialog.SelectedPath",
      "}",
    ].join("; ");
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-STA", "-Command", script], { windowsHide: true });
    const selected = stdout.trim();
    return selected || null;
  }

  if (process.platform === "linux") {
    const picker = await findLinuxDirectoryPicker();
    if (!picker) {
      throw new Error("No supported Linux folder picker found. Install zenity, kdialog, or yad, or enter the project path manually.");
    }
    try {
      const { stdout } = await execFileAsync(picker.command, picker.args);
      const selected = stdout.trim();
      return selected || null;
    } catch (error) {
      if (pickerWasCancelled(error)) return null;
      throw error;
    }
  }

  throw new Error("native directory picker is not available on this platform; enter the project path manually");
}

export function createProjectServer(runtime: ChefRuntime, baseServer: Server, options: ProjectServerOptions): Server {
  const baseHandler = baseServer.listeners("request")[0] as RequestHandler | undefined;
  if (!baseHandler) throw new Error("base HTTP server has no request handler");
  const recentProjectsPath = options.recentProjectsPath ?? resolve(homedir(), ".chef", "recent-projects.json");
  const pickDirectory = options.pickDirectory ?? defaultPickDirectory;
  const canPickDirectory = options.canPickDirectory ?? defaultCanPickDirectory;

  const openProject = async (rawPath: string, res: ServerResponse) => {
    const path = await validateDirectory(rawPath);
    if (isSameProjectPath(path, runtime.projectDir)) {
      const recent = await rememberProject(recentProjectsPath, path);
      sendJson(res, 200, { ok: true, data: { path, current: true, recent } });
      return;
    }
    const recent = await rememberProject(recentProjectsPath, path);
    sendJson(res, 202, { ok: true, data: { path, reopening: true, recent } });
    setTimeout(() => { void options.onOpenProject(path); }, 100);
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
      if (req.method === "GET" && url.pathname === "/api/project") {
        const recent = await readRecentProjects(recentProjectsPath);
        sendJson(res, 200, { ok: true, data: { path: resolve(runtime.projectDir), name: basename(resolve(runtime.projectDir)) || resolve(runtime.projectDir), recent, nativePicker: await canPickDirectory() } });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/project/open") {
        const body = await readBody(req) as { path?: unknown };
        if (typeof body.path !== "string" || !body.path.trim()) { sendJson(res, 400, { error: "path is required" }); return; }
        await openProject(body.path.trim(), res); return;
      }
      if (req.method === "POST" && url.pathname === "/api/project/pick") {
        const selected = await pickDirectory();
        if (!selected) { sendJson(res, 200, { ok: true, data: { cancelled: true } }); return; }
        await openProject(selected, res); return;
      }
      await baseHandler(req, res);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /must be a directory|ENOENT|no such file|path is required/i.test(message) ? 400 : 500;
      sendJson(res, status, { error: message });
    }
  });
}
