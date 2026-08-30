import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createChef } from "../src/main.ts";
import { createHttpServer } from "../src/server/http-server.ts";
import { createArtifactServer } from "../src/server/artifact-http.ts";
import { canRevealArtifact } from "../web/src/artifactHandoff.ts";

const projectDir = await mkdtemp(join(tmpdir(), "chef-local-result-reveal-"));
const outsideDir = await mkdtemp(join(tmpdir(), "chef-local-result-reveal-outside-"));
const resultDir = join(projectDir, "todo-app");
const resultPath = join(resultDir, "index.html");
const outsidePath = join(outsideDir, "outside.html");
await mkdir(resultDir, { recursive: true });
await writeFile(resultPath, "<main>todo</main>");
await writeFile(outsidePath, "outside");

const runtime = createChef({ dbPath: join(projectDir, "chef.sqlite"), projectDir });
const revealed: Array<{ path: string; isDirectory: boolean }> = [];
const server = createArtifactServer(runtime, createHttpServer(runtime), {
  revealPath: async (path, isDirectory) => { revealed.push({ path, isDirectory }); },
});

const requestReveal = async (artifactId: string) => {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${address.port}/api/artifacts/${encodeURIComponent(artifactId)}/reveal`, {
    method: "POST",
    headers: { "x-chef-action": "reveal-artifact" },
  });
  return { status: response.status, body: await response.json() as { error?: string } };
};

try {
  const local = runtime.repository.insertArtifact({
    id: "opaque-local-result",
    workspaceId: runtime.workspaceId,
    type: "code",
    name: "todo-app",
    uri: "sideband://worker/result",
    createdBy: "todo-builder",
    metadata: { resultLocation: "todo-app/index.html" },
  });
  const mixedCaseFileUri = runtime.repository.insertArtifact({
    id: "opaque-mixed-case-file-uri",
    workspaceId: runtime.workspaceId,
    type: "code",
    name: "todo-app-file-uri",
    uri: "sideband://worker/file-uri-result",
    createdBy: "todo-builder",
    metadata: { resultLocation: pathToFileURL(resultPath).href.replace(/^file:/, "FILE:") },
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

  assert.equal(canRevealArtifact(local), true, "Simple Mode should keep reveal available for an explicit durable local result path");
  assert.equal(canRevealArtifact(mixedCaseFileUri), true, "file URI schemes are case-insensitive and must remain revealable");
  assert.equal(canRevealArtifact(unsupported), false, "opaque results without a durable local location must not advertise reveal");
  assert.equal(canRevealArtifact(remote), false, "remote result URLs must not advertise a local filesystem reveal action");

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const localReveal = await requestReveal(local.id);
  assert.equal(localReveal.status, 200);
  assert.deepEqual(revealed, [{ path: resultPath, isDirectory: false }], "server must resolve the persisted relative result location inside the active project");

  const mixedCaseReveal = await requestReveal(mixedCaseFileUri.id);
  assert.equal(mixedCaseReveal.status, 200);
  assert.deepEqual(revealed.at(-1), { path: resultPath, isDirectory: false }, "server must accept equivalent mixed-case file URI schemes");

  const unsupportedReveal = await requestReveal(unsupported.id);
  assert.equal(unsupportedReveal.status, 409);
  assert.match(unsupportedReveal.body.error ?? "", /not backed by a local file/);

  const remoteReveal = await requestReveal(remote.id);
  assert.equal(remoteReveal.status, 409);
  assert.match(remoteReveal.body.error ?? "", /not a local file/);
  assert.equal(revealed.length, 2, "remote result locations must never be reinterpreted as project-relative filesystem paths");

  const outsideReveal = await requestReveal(outside.id);
  assert.equal(outsideReveal.status, 403);
  assert.match(outsideReveal.body.error ?? "", /outside the project root/);
  assert.equal(revealed.length, 2, "rejected result locations must never invoke the OS opener");

  console.log("artifact-local-result-reveal: ok — opaque artifacts retain safe project-scoped reveal when workers persist a local result path");
} finally {
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  await runtime.close();
  await rm(projectDir, { recursive: true, force: true });
  await rm(outsideDir, { recursive: true, force: true });
}
