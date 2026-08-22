import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "assets", "chef-icon.svg");
const targetDir = resolve(root, "web", "public");
const target = resolve(targetDir, "chef-icon.svg");

await mkdir(targetDir, { recursive: true });
await copyFile(source, target);
