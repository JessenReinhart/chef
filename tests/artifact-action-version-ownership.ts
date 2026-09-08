import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createChef } from "../src/main.ts";
import { createHttpServer } from "../src/server/http-server.ts";
import { createArtifactServer } from "../src/server/artifact-http.ts";
import {
  artifactActionStateKey,
  createSingleFlightArtifactDownloader,
  createSingleFlightArtifactRevealer,
  type ArtifactDownloadResult,
} from "../web/src/resultActions.ts";

let revealExpectedVersion: number | undefined;
const reveal = createSingleFlightArtifactRevealer(async (_artifactId, expectedVersion) => {
  revealExpectedVersion = expectedVersion;
  return { ok: true };
});
await reveal("todo-result", artifactActionStateKey("todo-result", 7));
assert.equal(revealExpectedVersion, 7, "Show result must carry the exact displayed artifact version into the side-effecting request");

let downloadExpectedVersion: number | undefined;
const download = createSingleFlightArtifactDownloader(async (_artifactId, expectedVersion) => {
  downloadExpectedVersion = expectedVersion;
  return { ok: false, error: "test stop" } satisfies ArtifactDownloadResult;
});
await download("todo-result", artifactActionStateKey("todo-result", 8));
assert.equal(downloadExpectedVersion, 8, "Save copy must carry the exact displayed artifact version into the file request");

const projectDir = await mkdtemp(join(tmpdir(), "chef-artifact-version-owned-"));
const resultDir = join(projectDir, "todo-app");
const resultPath = join(resultDir, "index.html");
await mkdir(resultDir, { recursive: true });
await writeFile(resultPath, "<main>todo</main>");

const runtime = createChef({ dbPath: join(projectDir, "chef.sqlite"), projectDir });
const opened: string[] = [];
const server = createArtifactServer(runtime, createHttpServer(runtime), {
  revealPath: async (path) => { opened.push(path); },
});

try {
  const artifact = runtime.repository.insertArtifact({
    id: "todo-result",
    workspaceId: runtime.workspaceId,
    type: "result",
    name: "todo-app",
    uri: pathToFileURL(resultPath).href,
    createdBy: "todo-builder",
    metadata: { resultLocation: "todo-app/index.html" },
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const staleVersion = artifact.version + 1;

  const staleReveal = await fetch(`${baseUrl}/api/artifacts/${artifact.id}/reveal`, {
    method: "POST",
    headers: {
      "x-chef-action": "reveal-artifact",
      "x-chef-expected-artifact-version": String(staleVersion),
    },
  });
  assert.equal(staleReveal.status, 409, "a stale Show result action must fail before opening whichever version is current now");
  assert.equal(opened.length, 0, "version mismatch must not invoke the desktop opener");
  assert.match((await staleReveal.json() as { error?: string }).error ?? "", /result changed/i, "stale reveal must explain that the visible result is no longer current");

  const staleDownload = await fetch(`${baseUrl}/api/artifacts/${artifact.id}/download`, {
    headers: { "x-chef-expected-artifact-version": String(staleVersion) },
  });
  assert.equal(staleDownload.status, 409, "a stale Save copy action must fail instead of streaming bytes for another version");
  assert.match((await staleDownload.json() as { error?: string }).error ?? "", /result changed/i, "stale download must explain that the visible result is no longer current");

  const currentReveal = await fetch(`${baseUrl}/api/artifacts/${artifact.id}/reveal`, {
    method: "POST",
    headers: {
      "x-chef-action": "reveal-artifact",
      "x-chef-expected-artifact-version": String(artifact.version),
    },
  });
  assert.equal(currentReveal.status, 200, "the exact displayed result version must remain revealable");
  assert.deepEqual(opened, [resultPath], "current-version reveal must still resolve the generated todo result");

  const currentDownload = await fetch(`${baseUrl}/api/artifacts/${artifact.id}/download`, {
    headers: { "x-chef-expected-artifact-version": String(artifact.version) },
  });
  assert.equal(currentDownload.status, 200, "the exact displayed result version must remain downloadable");
  assert.equal(await currentDownload.text(), "<main>todo</main>", "current-version Save copy must return the displayed generated result");

  console.log("artifact-action-version-ownership: ok — result actions carry exact versions and stale reveal/download requests fail before side effects");
} finally {
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  await runtime.close();
  await rm(projectDir, { recursive: true, force: true });
}
