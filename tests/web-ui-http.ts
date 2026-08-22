import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createWebUiServer } from "../src/server/web-ui-http.ts";

const root = await mkdtemp(join(tmpdir(), "chef-web-ui-"));
const distDir = join(root, "dist");
await mkdir(join(distDir, "assets"), { recursive: true });
await writeFile(join(distDir, "index.html"), "<!doctype html><title>Chef Local</title><div id=\"root\"></div>", "utf8");
await writeFile(join(distDir, "assets", "app.js"), "console.log('chef')", "utf8");

const baseServer = createServer((req, res) => {
  if (req.url === "/api/state") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, source: "runtime" }));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("runtime-404");
});
const server = createWebUiServer(baseServer, { distDir });

await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address();
assert.ok(address && typeof address === "object");
const origin = `http://127.0.0.1:${address.port}`;

try {
  const rootResponse = await fetch(`${origin}/`);
  assert.equal(rootResponse.status, 200);
  assert.match(rootResponse.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await rootResponse.text(), /Chef Local/);

  const assetResponse = await fetch(`${origin}/assets/app.js`);
  assert.equal(assetResponse.status, 200);
  assert.match(assetResponse.headers.get("content-type") ?? "", /text\/javascript/);
  assert.equal(await assetResponse.text(), "console.log('chef')");

  const routeResponse = await fetch(`${origin}/missions/mission-1`);
  assert.equal(routeResponse.status, 200);
  assert.match(await routeResponse.text(), /Chef Local/);

  const apiResponse = await fetch(`${origin}/api/state`);
  assert.equal(apiResponse.status, 200);
  assert.deepEqual(await apiResponse.json(), { ok: true, source: "runtime" });

  const missingAsset = await fetch(`${origin}/assets/missing.js`);
  assert.equal(missingAsset.status, 404);
  assert.equal(await missingAsset.text(), "runtime-404");

  const headResponse = await fetch(`${origin}/`, { method: "HEAD" });
  assert.equal(headResponse.status, 200);
  assert.equal(await headResponse.text(), "");

  console.log("web-ui-http: ok");
} finally {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  await rm(root, { recursive: true, force: true });
}
