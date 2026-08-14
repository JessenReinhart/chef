import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "chef-db-repro-"));
const dbPath = join(dir, "chef.sqlite");

const a = new DatabaseSync(dbPath);
a.exec("CREATE TABLE t(x)");
a.close();

const b = new DatabaseSync(dbPath);
b.prepare("SELECT * FROM t").all();
b.close();

try {
  rmSync(dbPath, { force: true });
  console.log("UNLINK OK after close() without GC");
} catch (e) {
  console.log("UNLINK FAILED (no GC):", e.code, e.message);
}

// Second scenario: try with explicit GC if available
if (globalThis.gc) {
  try {
    const c = new DatabaseSync(dbPath);
    c.exec("CREATE TABLE u(y)");
    c.close();
    globalThis.gc();
    rmSync(dbPath, { force: true });
    console.log("UNLINK OK after close() + globalThis.gc()");
  } catch (e) {
    console.log("UNLINK FAILED (after gc):", e.code, e.message);
  }
} else {
  console.log("globalThis.gc not available");
}

try {
  rmSync(dir, { recursive: true, force: true });
  console.log("DIR RM OK");
} catch (e) {
  console.log("DIR RM FAILED:", e.code, e.message);
}
