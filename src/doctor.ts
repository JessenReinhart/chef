import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { posix, win32 } from "node:path";

export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorStatus;
  detail: string;
}

export interface DoctorResult {
  ok: boolean;
  checks: DoctorCheck[];
}

export interface DoctorEnvironment {
  platform?: NodeJS.Platform;
  nodeVersion?: string;
  cwd?: string;
  path?: string;
  canAccess?: (path: string, mode: number) => Promise<void>;
}

const REQUIRED_NODE_MAJOR = 24;

const OPTIONAL_BINARIES = [
  { id: "git", label: "Git", names: ["git"] },
  { id: "claude-code", label: "Claude Code", names: ["claude"] },
  { id: "pi", label: "Pi", names: ["pi"] },
  { id: "omp", label: "OMP", names: ["omp"] },
  { id: "freebuff", label: "Freebuff", names: ["freebuff"] },
  { id: "codex", label: "Codex CLI", names: ["codex"] },
] as const;

function executableNames(name: string, platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return [name];
  return [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`];
}

async function findExecutable(
  names: readonly string[],
  pathValue: string,
  platform: NodeJS.Platform,
  canAccess: (path: string, mode: number) => Promise<void>,
): Promise<string | null> {
  const pathApi = platform === "win32" ? win32 : posix;
  const separator = platform === "win32" ? ";" : ":";
  const directories = pathValue.split(separator).filter(Boolean);
  for (const directory of directories) {
    for (const name of names) {
      for (const candidateName of executableNames(name, platform)) {
        const candidate = pathApi.join(directory, candidateName);
        try {
          await canAccess(candidate, constants.X_OK);
          return candidate;
        } catch {
          // Continue searching PATH.
        }
      }
    }
  }
  return null;
}

export async function runDoctor(environment: DoctorEnvironment = {}): Promise<DoctorResult> {
  const platform = environment.platform ?? process.platform;
  const nodeVersion = environment.nodeVersion ?? process.versions.node;
  const cwd = environment.cwd ?? process.cwd();
  const pathValue = environment.path ?? process.env.PATH ?? "";
  const canAccess = environment.canAccess ?? access;
  const checks: DoctorCheck[] = [];

  const nodeMajor = Number.parseInt(nodeVersion.split(".")[0] ?? "0", 10);
  checks.push({
    id: "node",
    label: "Node.js",
    status: nodeMajor >= REQUIRED_NODE_MAJOR ? "pass" : "fail",
    detail: nodeMajor >= REQUIRED_NODE_MAJOR
      ? `Node ${nodeVersion} meets Chef's >=${REQUIRED_NODE_MAJOR} requirement.`
      : `Node ${nodeVersion} is too old. Chef requires Node >=${REQUIRED_NODE_MAJOR}.`,
  });

  try {
    await canAccess(cwd, constants.R_OK | constants.W_OK);
    checks.push({ id: "workspace", label: "Project directory", status: "pass", detail: `${cwd} is readable and writable.` });
  } catch {
    checks.push({ id: "workspace", label: "Project directory", status: "fail", detail: `${cwd} is not readable and writable.` });
  }

  for (const binary of OPTIONAL_BINARIES) {
    const found = await findExecutable(binary.names, pathValue, platform, canAccess);
    const required = binary.id === "git";
    checks.push({
      id: binary.id,
      label: binary.label,
      status: found ? "pass" : "warn",
      detail: found
        ? `Found at ${found}.`
        : required
          ? "Not found on PATH. Git-backed development features will be unavailable."
          : "Not found on PATH. Chef can still run with other available harnesses.",
    });
  }

  return {
    ok: checks.every((check) => check.status !== "fail"),
    checks,
  };
}

export function formatDoctor(result: DoctorResult): string {
  const icon: Record<DoctorStatus, string> = { pass: "OK", warn: "WARN", fail: "FAIL" };
  const lines = ["Chef Doctor", ""];
  for (const check of result.checks) {
    lines.push(`[${icon[check.status]}] ${check.label}: ${check.detail}`);
  }
  lines.push("", result.ok ? "Environment is ready for Chef." : "Chef has blocking environment problems.");
  return lines.join("\n");
}
