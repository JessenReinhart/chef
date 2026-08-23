import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { createChef, type ChefRuntime } from "../src/main.ts";
import { createHttpServer } from "../src/server/http-server.ts";

const MARKER_FILE = "chef-e2e-proof.txt";
const MARKER = "CHEF_E2E_OK";
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function hasLLMKey(): boolean {
  return Boolean(
    process.env.ANTHROPIC_API_KEY
    || process.env.OPENAI_API_KEY
    || process.env.CHEF_API_KEY,
  );
}

async function ensureInteractiveLLMConfig(): Promise<void> {
  const configuredProvider = process.env.CHEF_PROVIDER?.trim();
  if (configuredProvider && hasLLMKey()) return;

  assert.ok(
    process.stdin.isTTY && process.stdout.isTTY,
    "Live E2E needs LLM configuration. Run interactively to enter endpoint/model/API key, or set CHEF_PROVIDER plus ANTHROPIC_API_KEY, OPENAI_API_KEY, or CHEF_API_KEY.",
  );

  console.log("\n[live-e2e] Chef LLM configuration is incomplete.");
  console.log("[live-e2e] Enter the provider details for this run only. Nothing is written to .env or the debug trace.");
  if (!configuredProvider) {
    console.log("[live-e2e] Provider will default to custom (OpenAI-compatible endpoint).\n");
  }

  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });

  try {
    const currentEndpoint = process.env.CHEF_BASE_URL?.trim() ?? "";
    const currentModel = process.env.CHEF_MODEL?.trim() ?? "";
    const endpointPrompt = currentEndpoint
      ? `LLM endpoint [${currentEndpoint}]: `
      : "LLM endpoint: ";
    const modelPrompt = currentModel
      ? `Model name [${currentModel}]: `
      : "Model name: ";

    const endpoint = (await rl.question(endpointPrompt)).trim() || currentEndpoint;
    const model = (await rl.question(modelPrompt)).trim() || currentModel;

    let promptedApiKey: string | undefined;
    if (hasLLMKey()) {
      console.log("[live-e2e] API key: detected from environment, keeping it.");
    } else {
      const keyPromise = rl.question("API key (hidden): ");
      muted = true;
      promptedApiKey = (await keyPromise).trim();
      muted = false;
      process.stdout.write("\n");
    }

    assert.ok(endpoint, "LLM endpoint is required for interactive live E2E configuration");
    assert.ok(model, "Model name is required for interactive live E2E configuration");
    assert.ok(hasLLMKey() || promptedApiKey, "API key is required for interactive live E2E configuration");

    process.env.CHEF_PROVIDER = configuredProvider || "custom";
    process.env.CHEF_BASE_URL = endpoint;
    process.env.CHEF_MODEL = model;
    if (!hasLLMKey() && promptedApiKey) process.env.CHEF_API_KEY = promptedApiKey;

    console.log(`[live-e2e] Using ${process.env.CHEF_PROVIDER}/${model} at ${endpoint}\n`);
  } finally {
    muted = false;
    rl.close();
  }
}

function boundedJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "string" && item.length > 4_000) {
      return `${item.slice(0, 4_000)}…[truncated]`;
    }
    return item;
  })) as unknown;
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}

async function main(): Promise<void> {
  // This is a diagnostic command, so routing/provider logs are useful by default.
  // Callers can explicitly set either variable to 0 to silence that channel.
  process.env.CHEF_LLM_DEBUG ??= "1";
  process.env.CHEF_RUNTIME_DEBUG ??= "1";

  await ensureInteractiveLLMConfig();

  const configuredTimeout = Number(process.env.CHEF_E2E_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  assert.ok(
    Number.isFinite(configuredTimeout) && configuredTimeout > 0,
    "CHEF_E2E_TIMEOUT_MS must be a positive number of milliseconds",
  );

  const projectDir = await mkdtemp(join(tmpdir(), "chef-live-e2e-"));
  const dbPath = join(projectDir, "chef.sqlite");
  const proofPath = join(projectDir, MARKER_FILE);
  const debugDir = resolve(process.cwd(), ".chef-debug");
  const tracePath = join(debugDir, "live-mission-e2e-latest.json");
  const startedAt = Date.now();

  let chef: ChefRuntime | undefined;
  let server: Server | undefined;
  let failure: string | null = null;
  let httpResult: unknown = null;
  let proofContent: string | null = null;
  let passed = false;

  const trace: Record<string, unknown> = {
    startedAt: new Date(startedAt).toISOString(),
    platform: process.platform,
    node: process.version,
    projectDir,
    request: null,
    llm: null,
    harnesses: null,
    httpResult: null,
    proof: null,
    snapshot: null,
    failure: null,
  };

  try {
    await writeFile(
      join(projectDir, "README.md"),
      "# Chef live E2E fixture\n\nThis temporary project exists only for the live Mission diagnostic.\n",
      "utf8",
    );

    chef = createChef({
      dbPath,
      projectDir,
      orchestratorTimeoutMs: configuredTimeout,
    });
    await chef.start();

    trace.llm = chef.llmStatus;
    const detections = chef.specializedHarnesses.detections();
    trace.harnesses = detections;

    assert.equal(
      chef.llmStatus.configured,
      true,
      "Live E2E requires a configured LLM. Set CHEF_PROVIDER plus ANTHROPIC_API_KEY, OPENAI_API_KEY, or CHEF_API_KEY (and CHEF_MODEL/CHEF_BASE_URL when needed).",
    );

    const taskCapableWorkers = detections.filter((worker) => worker.available && worker.taskCapable);
    assert.ok(
      taskCapableWorkers.length > 0,
      `Live E2E requires at least one detected task-capable worker. Detections: ${detections.map((worker) => `${worker.id}=${worker.available ? "available" : "missing"}/${worker.taskCapable ? "task" : "interactive"}`).join(", ")}`,
    );

    server = createHttpServer(chef);
    await new Promise<void>((resolveListen, rejectListen) => {
      server!.once("error", rejectListen);
      server!.listen(0, "127.0.0.1", resolveListen);
    });
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const request = [
      "This is an end-to-end diagnostic Mission.",
      `Create a file named ${MARKER_FILE} in the current project root.`,
      `The file must contain ${MARKER}.`,
      "Verify the file exists and contains that marker before finishing.",
      "Do not modify any other project file.",
      "Complete the work and exit when done.",
    ].join(" ");
    trace.request = request;

    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: request }),
    });
    const body = await response.json() as {
      ok?: boolean;
      data?: { ok?: boolean; taskIds?: string[]; report?: string };
      error?: string;
    };
    httpResult = { status: response.status, body };
    trace.httpResult = httpResult;

    assert.equal(response.status, 200, `POST /api/chat failed with HTTP ${response.status}: ${JSON.stringify(body)}`);
    assert.equal(body.ok, true, `Chef reported Mission failure: ${body.data?.report ?? body.error ?? "unknown error"}`);
    assert.equal(body.data?.ok, true, `Runtime result was not successful: ${body.data?.report ?? "no report"}`);
    assert.ok((body.data?.taskIds?.length ?? 0) > 0, "Mission must create at least one Task");

    proofContent = await readFile(proofPath, "utf8");
    trace.proof = { path: proofPath, content: proofContent };
    assert.equal(proofContent.trim(), MARKER, `Worker output proof is wrong: expected ${MARKER}`);

    const snapshot = await chef.inspectState();
    trace.snapshot = boundedJson(snapshot);
    const missionTasks = snapshot.tasks.filter((task) => body.data?.taskIds?.includes(task.id));
    const taskCapableIds = new Set(taskCapableWorkers.map((worker) => worker.id));

    assert.equal(missionTasks.length, body.data?.taskIds?.length, "Every returned Task id must exist in durable state");
    assert.ok(missionTasks.every((task) => task.status === "completed"), "Every Mission Task must finish as completed");
    assert.ok(
      missionTasks.every((task) => task.assignedTo !== undefined && taskCapableIds.has(task.assignedTo)),
      "Every Mission Task must be assigned to a detected task-capable worker",
    );

    const missionSessions = snapshot.sessions.filter((session) => body.data?.taskIds?.includes(session.taskId));
    assert.ok(missionSessions.length > 0, "Mission must spawn at least one real worker Session");
    assert.ok(missionSessions.every((session) => session.status === "completed"), "Every Mission Session must terminate successfully");
    assert.ok(
      missionSessions.every((session) => session.command !== "node"),
      "Mission worker execution must not silently fall back to a bare Node process",
    );

    const eventTypes = new Set(snapshot.events.map((event) => event.type));
    for (const required of ["mission.created", "chat.plan.proposed", "orchestrator.plan.executing", "mission.status"]) {
      assert.ok(eventTypes.has(required), `Runtime trace is missing required event: ${required}`);
    }
    assert.ok(
      snapshot.events.some((event) => event.type === "task.completed"),
      "Runtime trace must record Task completion",
    );

    passed = true;
    console.log(`live-mission-e2e: ok — ${chef.llmStatus.provider}/${chef.llmStatus.model}, worker(s): ${[...new Set(missionTasks.map((task) => task.assignedTo))].join(", ")}`);
  } catch (error) {
    failure = errorMessage(error);
    trace.failure = failure;
    throw error;
  } finally {
    if (chef && trace.snapshot === null) {
      try {
        trace.snapshot = boundedJson(await chef.inspectState());
      } catch (error) {
        trace.snapshot = { error: errorMessage(error) };
      }
    }

    try {
      await closeServer(server);
    } catch (error) {
      trace.serverCloseError = errorMessage(error);
    }

    if (chef) {
      try {
        await chef.close();
      } catch (error) {
        trace.runtimeCloseError = errorMessage(error);
      }
    }

    trace.httpResult = trace.httpResult ?? httpResult;
    trace.proof = trace.proof ?? (proofContent === null ? { path: proofPath, exists: false } : { path: proofPath, content: proofContent });
    trace.failure = failure;
    trace.passed = passed;
    trace.finishedAt = new Date().toISOString();
    trace.durationMs = Date.now() - startedAt;

    await mkdir(debugDir, { recursive: true });
    await writeFile(tracePath, `${JSON.stringify(boundedJson(trace), null, 2)}\n`, "utf8");
    console.error(`[live-e2e] diagnostic trace: ${tracePath}`);

    // Successful runs clean themselves up. Failed runs intentionally preserve
    // the temporary project + SQLite state so the exact failure can be inspected.
    if (passed && process.env.CHEF_E2E_KEEP_PROJECT !== "1") {
      await rm(projectDir, { recursive: true, force: true });
    } else {
      console.error(`[live-e2e] preserved fixture: ${projectDir}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(`[live-e2e] FAILED: ${errorMessage(error)}`);
  process.exitCode = 1;
});
