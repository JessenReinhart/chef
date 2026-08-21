import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface OrchestratorProviderSettings {
  provider: "anthropic" | "openai" | "custom" | null;
  model: string;
  baseUrl?: string;
  configured: boolean;
  hasApiKey: boolean;
}

interface PersistedProviderSettings {
  provider: "anthropic" | "openai" | "custom" | null;
  model: string;
  baseUrl?: string;
  encryptedApiKey?: string;
  plainApiKey?: string;
}

const settingsPath = resolve(homedir(), ".chef", "orchestrator-provider.json");

async function protectWindows(value: string): Promise<string> {
  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.Security",
    "$bytes=[Text.Encoding]::UTF8.GetBytes($env:CHEF_SECRET)",
    "$enc=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Convert]::ToBase64String($enc)",
  ].join("; ");
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
    windowsHide: true,
    env: { ...process.env, CHEF_SECRET: value },
  });
  return stdout.trim();
}

async function unprotectWindows(value: string): Promise<string> {
  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.Security",
    "$enc=[Convert]::FromBase64String($env:CHEF_SECRET)",
    "$bytes=[System.Security.Cryptography.ProtectedData]::Unprotect($enc,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Text.Encoding]::UTF8.GetString($bytes)",
  ].join("; ");
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
    windowsHide: true,
    env: { ...process.env, CHEF_SECRET: value },
  });
  return stdout.trim();
}

async function readPersisted(): Promise<PersistedProviderSettings | null> {
  try {
    const parsed = JSON.parse(await readFile(settingsPath, "utf8")) as PersistedProviderSettings;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export async function loadOrchestratorProviderSettings(): Promise<{ settings: OrchestratorProviderSettings; apiKey: string | null }> {
  const persisted = await readPersisted();
  if (!persisted?.provider) {
    return { settings: { provider: null, model: "", configured: false, hasApiKey: false }, apiKey: null };
  }
  let apiKey: string | null = null;
  if (persisted.encryptedApiKey && process.platform === "win32") {
    try { apiKey = await unprotectWindows(persisted.encryptedApiKey); } catch { apiKey = null; }
  } else if (persisted.plainApiKey) {
    apiKey = persisted.plainApiKey;
  }
  return {
    settings: {
      provider: persisted.provider,
      model: persisted.model,
      baseUrl: persisted.baseUrl,
      configured: Boolean(persisted.provider && persisted.model && apiKey),
      hasApiKey: Boolean(apiKey),
    },
    apiKey,
  };
}

export async function saveOrchestratorProviderSettings(input: { provider: string; model: string; baseUrl?: string; apiKey?: string }): Promise<OrchestratorProviderSettings> {
  const provider = input.provider.toLowerCase();
  if (!["anthropic", "openai", "custom"].includes(provider)) throw new Error("provider must be anthropic, openai, or custom");
  const model = input.model.trim();
  if (!model) throw new Error("model is required");
  const previous = await readPersisted();
  const next: PersistedProviderSettings = {
    provider: provider as PersistedProviderSettings["provider"],
    model,
    baseUrl: input.baseUrl?.trim() || undefined,
  };
  const apiKey = input.apiKey?.trim();
  if (apiKey) {
    if (process.platform === "win32") next.encryptedApiKey = await protectWindows(apiKey);
    else next.plainApiKey = apiKey;
  } else if (previous?.encryptedApiKey) {
    next.encryptedApiKey = previous.encryptedApiKey;
  } else if (previous?.plainApiKey) {
    next.plainApiKey = previous.plainApiKey;
  }
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, JSON.stringify(next, null, 2), "utf8");
  if (process.platform !== "win32") {
    try { await chmod(settingsPath, 0o600); } catch { /* best effort */ }
  }
  const loaded = await loadOrchestratorProviderSettings();
  return loaded.settings;
}

export async function applyOrchestratorProviderEnv(): Promise<void> {
  if (process.env.CHEF_PROVIDER && (process.env.CHEF_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY)) return;
  const { settings, apiKey } = await loadOrchestratorProviderSettings();
  if (!settings.provider || !settings.model || !apiKey) return;
  process.env.CHEF_PROVIDER = settings.provider;
  process.env.CHEF_MODEL = settings.model;
  process.env.CHEF_API_KEY = apiKey;
  if (settings.baseUrl) process.env.CHEF_BASE_URL = settings.baseUrl;
}
