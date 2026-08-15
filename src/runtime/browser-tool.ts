/**
 * Chef P0 — Browser Tool (Phase 8)
 *
 * Playwright browser sessions as inspectable tool nodes. Actions: navigate,
 * click, extract, screenshot. Screenshot → artifact with provenance.
 *
 * Playwright is optional: when not installed, every action fails loudly with
 * a CapabilityUnavailableError — never a fake/silent fallback.
 */

import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Artifact,
  ArtifactType,
  WorkspaceId,
} from "../core/types.ts";
import type { ToolContext } from "./tool-runner.ts";

export type BrowserAction = "navigate" | "click" | "extract" | "screenshot";

export interface BrowserConfig {
  headless?: boolean;
  timeoutMs?: number;
  viewport?: { width: number; height: number };
  userAgent?: string;
}

export interface BrowserActionResult {
  type: "text" | "html" | "screenshot";
  value: string;
}

const PLAYWRIGHT_TIMEOUT_MS = 30_000;

// Type-only dynamic import guard — `playwright` is an optional dependency.
// We import lazily so the module loads without Playwright installed.
let cachedPlaywright: unknown = null;

/** Detect whether Playwright is installed and importable. Cached after first call. */
async function loadPlaywright(): Promise<{ chromium: unknown; errors: { new (message: string): Error } }> {
  if (cachedPlaywright !== null) {
    return cachedPlaywright as { chromium: unknown; errors: { new (message: string): Error } };
  }
  try {
    const mod = await import("playwright");
    cachedPlaywright = mod;
    return mod as { chromium: unknown; errors: { new (message: string): Error } };
  } catch {
    cachedPlaywright = "unavailable";
    throw new BrowserUnavailableError("Playwright is not installed — browser tool unavailable");
  }
}

/** Raised when Playwright is not installed (graceful degradation). */
export class BrowserUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserUnavailableError";
  }
}

/** In-memory browser session state. Sessions are ephemeral per server run. */
interface BrowserSession {
  id: string;
  browser: unknown; // chromium.Browser
  page: unknown; // Page
  createdAt: number;
}

/** Live browser sessions, keyed by id. */
export class BrowserTool {
  readonly #sessions = new Map<string, BrowserSession>();

  /** All sessions in this run. */
  listSessions(): BrowserSession[] {
    return [...this.#sessions.values()];
  }

  /** Get a session by id, or null. */
  getSession(sessionId: string): BrowserSession | null {
    return this.#sessions.get(sessionId) ?? null;
  }

  /** Navigate, click, extract, or screenshot on a page. Creates a session if none provided. */
  async action(
    ctx: ToolContext,
    params: {
      sessionId?: string;
      action: BrowserAction;
      url?: string;
      selector?: string;
      config?: BrowserConfig;
    },
  ): Promise<{ output: BrowserActionResult; artifact?: Artifact; sessionId: string }> {
    await loadPlaywright();

    const mod = cachedPlaywright as { chromium: { launch: (opts: Record<string, unknown>) => Promise<unknown> } };
    let session = params.sessionId ? this.#sessions.get(params.sessionId) : undefined;
    let page: unknown;

    if (!session) {
      const browser = await mod.chromium.launch({
        headless: params.config?.headless ?? true,
      });
      const pageResult = await (browser as { newPage: () => Promise<unknown> }).newPage();
      page = pageResult;
      session = { id: randomUUID(), browser, page: pageResult, createdAt: Date.now() };
      this.#sessions.set(session.id, session);
    } else {
      page = session.page;
    }

    const timeout = params.config?.timeoutMs ?? PLAYWRIGHT_TIMEOUT_MS;
    let result: BrowserActionResult;

    if (params.action === "navigate") {
      if (!params.url) throw new Error("browser navigate: url is required");
      const typedPage = page as { goto: (url: string, opts: { timeout: number }) => Promise<void> };
      await typedPage.goto(params.url, { timeout });
      result = { type: "html", value: await (page as { content: () => Promise<string> }).content() };
    } else if (params.action === "click") {
      if (!params.selector) throw new Error("browser click: selector is required");
      const typedPage = page as { click: (selector: string, opts: { timeout: number }) => Promise<void> };
      await typedPage.click(params.selector, { timeout });
      result = { type: "text", value: "ok" };
    } else if (params.action === "extract") {
      if (!params.selector) throw new Error("browser extract: selector is required");
      const typedPage = page as { innerText: (selector: string) => Promise<string> };
      result = { type: "text", value: await typedPage.innerText(params.selector) };
    } else if (params.action === "screenshot") {
      const typedPage = page as { screenshot: (opts: { fullPage?: boolean }) => Promise<Buffer> };
      const buffer = await typedPage.screenshot({ fullPage: true });
      const artifact = await this.#persistScreenshot(ctx, session.id, buffer);
      result = { type: "screenshot", value: `sideband://browser/${session.id}/${artifact.id}}` };
      return { output: result, artifact, sessionId: session.id };
    } else {
      throw new Error(`browser: unknown action '${params.action}'`);
    }

    return { output: result, sessionId: session.id };
  }

  /** Close a single session. */
  async closeSession(sessionId: string): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    this.#sessions.delete(sessionId);
    if (cachedPlaywright !== "unavailable") {
      try {
        await (session.browser as { close: () => Promise<void> }).close();
      } catch {
        // best effort
      }
    }
  }

  /** Close all sessions (server shutdown). */
  async close(): Promise<void> {
    await Promise.allSettled([...this.#sessions.values()].map((s) => s.browser as { close: () => Promise<void> }).map((b) => b.close()));
    this.#sessions.clear();
  }

  async #persistScreenshot(ctx: ToolContext, sessionId: string, buffer: Buffer): Promise<Artifact> {
    const id = randomUUID();
    const path = join(ctx.projectDir, ".chef-browser-screenshots", `${id}.png`);
    await writeFile(path, buffer);
    return {
      id,
      workspaceId: ctx.workspaceId,
      type: "image" as ArtifactType,
      name: `browser-screenshot-${sessionId}`,
      uri: `sideband://browser/${sessionId}/${id}`,
      version: 1,
      createdBy: "browser-tool",
      sessionId,
      metadata: { bytes: buffer.length, path },
    };
  }
}
