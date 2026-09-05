import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createChef } from "../src/main.ts";
import { createHttpServer } from "../src/server/http-server.ts";
import { createArtifactServer } from "../src/server/artifact-http.ts";
import { canRevealArtifact, isFileUriArtifact } from "../web/src/artifactHandoff.ts";
import { probeArtifactDownloadability, watchArtifactDownloadability } from "../web/src/artifactDownloadCapability.ts";
import { artifactRevealLabel, revealArtifact } from "../web/src/resultActions.ts";

const projectDir = await mkdtemp(join(tmpdir(), "chef-local-result-reveal-"));
const outsideDir = await mkdtemp(join(tmpdir(), "chef-local-result-reveal-outside-"));
const resultDir = join(projectDir, "todo-app");
const resultPath = join(resultDir, "index.html");
const outsidePath = join(outsideDir, "outside.html");
await mkdir(resultDir, { recursive: true });
await writeFile(resultPath, "<main>todo</main>");
await writeFile(outsidePath, "outside");

assert.equal(artifactRevealLabel("idle"), "Show result", "result reveal must describe the user outcome rather than a platform-specific folder action");
assert.equal(artifactRevealLabel("opening"), "Opening…", "an in-flight reveal must remain visibly acknowledged");
assert.equal(artifactRevealLabel("opened"), "Result shown", "successful reveal must not falsely claim only a folder was opened");
assert.equal(artifactRevealLabel("error"), "Show result", "failed reveal should return to a truthful retry action");

const fallbackReveal = await revealArtifact("result-with-error", async () => ({
  ok: false,
  json: async () => { throw new Error("non-json response"); },
}));
assert.deepEqual(fallbackReveal, { ok: false, error: "Could not show this result" }, "reveal failure fallback must remain platform-neutral");
assert.equal(
  await probeArtifactDownloadability("transient", 1, async () => ({ ok: false, status: 503, headers: new Headers() })),
  null,
  "transient capability failures must remain retryable instead of permanently hiding Save copy",
);
assert.equal(
  await probeArtifactDownloadability("missing", 1, async () => ({ ok: false, status: 404, headers: new Headers() })),
  false,
  "deterministic artifact rejections must not advertise Save copy",
);
assert.equal(
  await probeArtifactDownloadability("version-race", 1, async () => ({
    ok: true,
    status: 204,
    headers: new Headers({ "x-chef-artifact-version": "2" }),
  })),
  null,
  "a capability response for a newer artifact version must never enable Save copy on a stale result card",
);

let transientAttempts = 0;
await new Promise<void>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("transient artifact capability did not recover")), 1_000);
  const stop = watchArtifactDownloadability("recovering", 3, (downloadable) => {
    try {
      assert.equal(downloadable, true, "a transient capability failure must recover without an unrelated artifact refresh");
      assert.equal(transientAttempts, 2, "capability watcher should retry the same exact artifact version after transient failure");
      clearTimeout(timeout);
      stop();
      resolve();
    } catch (error) {
      clearTimeout(timeout);
      stop();
      reject(error);
    }
  }, {
    retryDelayMs: 0,
    requester: async () => {
      transientAttempts += 1;
      return transientAttempts === 1
        ? { ok: false, status: 503, headers: new Headers() }
        : { ok: true, status: 204, headers: new Headers({ "x-chef-artifact-version": "3" }) };
    },
  });
});

const runtime = createChef({ dbPath: join(projectDir, "chef.sqlite"), projectDir });
const revealed: Array<{ path: string; isDirectory: boolean }> = [];
const server = createArtifactServer(runtime, createHttpServer(runtime), {
  revealPath: async (path, isDirectory) => { revealed.push({ path, isDirectory }); },
});

const serverBaseUrl = () => {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
};

const requestReveal = async (artifactId: string) => {
  const response = await fetch(`${serverBaseUrl()}/api/artifacts/${encodeURIComponent(artifactId)}/reveal`, {
    method: "POST",
    headers: { "x-chef-action": "reveal-artifact" },
  });
  return { status: response.status, body: await response.json() as { error?: string } };
};

const requestDownloadCapability = (artifactId: string, artifactVersion: number) => probeArtifactDownloadability(
  artifactId,
  artifactVersion,
  (input, init) => fetch(new URL(String(input), serverBaseUrl()), init),
);

try {
  const canonicalTodo = runtime.repository.insertArtifact({
    id: "canonical-todo-result",
    workspaceId: runtime.workspaceId,
    type: "result",
    name: "todo-app",
    uri: pathToFileURL(resultPath).href,
    createdBy: "todo-builder",
    metadata: {
      content: `Created runnable todo app at ${resultPath}`,
      run: `${process.execPath} ${resultPath}`,
      verifiedBy: "golden-path",
    },
  });
  const canonicalTodoDirectory = runtime.repository.insertArtifact({
    id: "canonical-todo-directory",
    workspaceId: runtime.workspaceId,
    type: "result",
    name: "todo-app-root",
    uri: pathToFileURL(resultDir).href,
    createdBy: "todo-builder",
    metadata: {
      content: `Created runnable todo app at ${resultDir}`,
      run: "npm start",
      verifiedBy: "golden-path",
    },
  });
  const local = runtime.repository.insertArtifact({
    id: "opaque-local-result",
    workspaceId: runtime.workspaceId,
    type: "code",
    name: "todo-app",
    uri: "sideband://worker/result",
    createdBy: "todo-builder",
    metadata: { resultLocation: "todo-app/index.html" },
  });
  const mixedCaseMetadataLocation = runtime.repository.insertArtifact({
    id: "opaque-mixed-case-file-location",
    workspaceId: runtime.workspaceId,
    type: "code",
    name: "todo-app-file-location",
    uri: "sideband://worker/file-uri-result",
    createdBy: "todo-builder",
    metadata: { resultLocation: pathToFileURL(resultPath).href.replace(/^file:/, "FILE:") },
  });
  const mixedCaseFileUri = runtime.repository.insertArtifact({
    id: "mixed-case-file-uri",
    workspaceId: runtime.workspaceId,
    type: "code",
    name: "todo-app-file-uri",
    uri: pathToFileURL(resultPath).href.replace(/^file:/, "FILE:"),
    createdBy: "todo-builder",
    metadata: {},
  });
  const unsupported = runtime.repository.insertArtifact({
    id: "opaque-without-location",
    workspaceId: runtime.workspaceId,
    type: "result",
    name: "opaque result",
    uri: "sideband://worker/opaque",
    createdBy: "todo-builder",
    metadata: {},
  });
  const remote = runtime.repository.insertArtifact({
    id: "opaque-remote-result",
    workspaceId: runtime.workspaceId,
    type: "result",
    name: "remote result",
    uri: "sideband://worker/remote",
    createdBy: "todo-builder",
    metadata: { location: "https://example.com/results/todo-app" },
  });
  const outside = runtime.repository.insertArtifact({
    id: "opaque-outside-project",
    workspaceId: runtime.workspaceId,
    type: "file",
    name: "outside result",
    uri: "sideband://worker/outside",
    createdBy: "todo-builder",
    metadata: { resultLocation: outsidePath },
  });

  assert.equal(canRevealArtifact(canonicalTodo), true, "the canonical todo result must advertise Show result in Simple Mode");
  assert.equal(canRevealArtifact(canonicalTodoDirectory), true, "the canonical todo app root must remain revealable even though it is not a downloadable file");
  assert.equal(canRevealArtifact(local), true, "Simple Mode should keep reveal available for an explicit durable local result path");
  assert.equal(canRevealArtifact(mixedCaseMetadataLocation), true, "mixed-case file URI metadata must remain revealable for opaque artifacts");
  assert.equal(canRevealArtifact(mixedCaseFileUri), true, "file URI schemes are case-insensitive and must remain revealable");
  assert.equal(isFileUriArtifact(mixedCaseFileUri), true, "mixed-case file URIs must remain file-backed for download/save actions");
  assert.equal(isFileUriArtifact(mixedCaseMetadataLocation), false, "opaque artifacts must not advertise file-URI download semantics solely from result metadata");
  assert.equal(isFileUriArtifact(local), false, "opaque artifacts with only local metadata must not masquerade as downloadable file-URI artifacts");
  assert.equal(canRevealArtifact(unsupported), false, "opaque results without a durable local location must not advertise reveal");
  assert.equal(canRevealArtifact(remote), false, "remote result URLs must not advertise a local filesystem reveal action");

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  assert.equal(await requestDownloadCapability(canonicalTodo.id, canonicalTodo.version), true, "a real project-contained file must advertise Save copy through the production HTTP boundary");
  assert.equal(await requestDownloadCapability(canonicalTodoDirectory.id, canonicalTodoDirectory.version), false, "a runnable app directory must not advertise a file-only Save copy action");
  assert.equal(await requestDownloadCapability(unsupported.id, unsupported.version), false, "an artifact without a local backing file must not become downloadable");
  assert.equal(await requestDownloadCapability(remote.id, remote.version), false, "a remote result must not become a local download capability");
  assert.equal(await requestDownloadCapability(outside.id, outside.version), false, "an out-of-project path must fail closed during capability checks");
  assert.equal(await requestDownloadCapability("missing-artifact", 1), false, "a missing durable result must not advertise Save copy");
  assert.equal(revealed.length, 0, "download capability checks must never invoke the desktop opener");

  const canonicalTodoReveal = await requestReveal(canonicalTodo.id);
  assert.equal(canonicalTodoReveal.status, 200, "the canonical generated todo result must cross the production Show result endpoint");
  assert.deepEqual(revealed, [{ path: resultPath, isDirectory: false }], "Show result must resolve the canonical todo artifact to its generated file inside the selected project");

  const directoryReveal = await requestReveal(canonicalTodoDirectory.id);
  assert.equal(directoryReveal.status, 200, "directory results must remain available through Show result");
  assert.deepEqual(revealed.at(-1), { path: resultDir, isDirectory: true }, "Show result must continue to open the runnable app root without treating it as a file download");

  const localReveal = await requestReveal(local.id);
  assert.equal(localReveal.status, 200);
  assert.deepEqual(revealed.at(-1), { path: resultPath, isDirectory: false }, "server must resolve the persisted relative result location inside the active project");

  const metadataLocationReveal = await requestReveal(mixedCaseMetadataLocation.id);
  assert.equal(metadataLocationReveal.status, 200);
  assert.deepEqual(revealed.at(-1), { path: resultPath, isDirectory: false }, "server must accept mixed-case file URI schemes stored as durable result metadata");

  const mixedCaseReveal = await requestReveal(mixedCaseFileUri.id);
  assert.equal(mixedCaseReveal.status, 200);
  assert.deepEqual(revealed.at(-1), { path: resultPath, isDirectory: false }, "server must accept equivalent mixed-case artifact file URI schemes");

  const unsupportedReveal = await requestReveal(unsupported.id);
  assert.equal(unsupportedReveal.status, 409);
  assert.match(unsupportedReveal.body.error ?? "", /not backed by a local file/);

  const remoteReveal = await requestReveal(remote.id);
  assert.equal(remoteReveal.status, 409);
  assert.match(remoteReveal.body.error ?? "", /not a local file/);
  assert.equal(revealed.length, 5, "remote result locations must never be reinterpreted as project-relative filesystem paths");

  const outsideReveal = await requestReveal(outside.id);
  assert.equal(outsideReveal.status, 403);
  assert.match(outsideReveal.body.error ?? "", /outside the project root/);
  assert.equal(revealed.length, 5, "rejected result locations must never invoke the OS opener");

  console.log("artifact-local-result-reveal: ok — Simple Mode exposes truthful file/download capabilities while keeping local result reveal safe, retryable, version-bound, and project-scoped");
} finally {
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  await runtime.close();
  await rm(projectDir, { recursive: true, force: true });
  await rm(outsideDir, { recursive: true, force: true });
}
