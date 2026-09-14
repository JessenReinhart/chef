import { strict as assert } from "node:assert";

import { sameSelectedProjectPath, waitForSelectedProject } from "../web/src/projectSelection.ts";

assert.equal(
  sameSelectedProjectPath("C:\\Dev\\Todo-App", "\\\\?\\C:\\dev\\todo-app\\"),
  true,
  "ordinary and extended-length Windows drive paths must identify the same selected project",
);
assert.equal(
  sameSelectedProjectPath("C:\\Dev\\.\\Todo-App\\.", "\\\\?\\C:\\dev\\todo-app"),
  true,
  "extended-length drive paths must preserve existing dot-segment normalization",
);
assert.equal(
  sameSelectedProjectPath("\\\\SERVER\\Share\\Todo-App", "\\\\?\\UNC\\server\\share\\todo-app\\"),
  true,
  "ordinary UNC and extended-length UNC paths must identify the same selected project",
);
assert.equal(
  sameSelectedProjectPath("C:\\Dev\\Todo-App", "\\\\?\\C:\\dev\\other-app"),
  false,
  "extended-length normalization must not collapse distinct project directories",
);
assert.equal(
  sameSelectedProjectPath("/home/alice/Todo-App", "/home/alice/todo-app"),
  false,
  "Windows extended-path support must not change Linux case-sensitive project identity",
);

const selected = await waitForSelectedProject(
  "C:\\Dev\\Todo-App",
  async () => ({ name: "Todo-App", path: "\\\\?\\C:\\DEV\\TODO-APP\\" }),
  async () => {},
  1,
);
assert.equal(
  selected.path,
  "\\\\?\\C:\\DEV\\TODO-APP\\",
  "project confirmation must settle immediately when the reopened runtime reports the selected directory using extended-length syntax",
);

const selectedUnc = await waitForSelectedProject(
  "\\\\server\\share\\Todo-App",
  async () => ({ name: "Todo-App", path: "\\\\?\\UNC\\SERVER\\SHARE\\TODO-APP" }),
  async () => {},
  1,
);
assert.equal(
  selectedUnc.name,
  "Todo-App",
  "project confirmation must settle for equivalent extended-length UNC paths",
);

console.log("project-selection-path-identity: ok — Windows drive and UNC extended-length paths settle as the same selected project without changing Linux identity");
