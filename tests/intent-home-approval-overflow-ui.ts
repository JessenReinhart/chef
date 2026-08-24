import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

const home = await readFile(new URL("../web/src/IntentHome.tsx", import.meta.url), "utf8");

assert.match(
  home,
  /missionApprovals\.slice\(0, 2\)\.map\(renderApproval\)/,
  "Home should keep the first two selected-Thread approvals visible by default",
);
assert.match(
  home,
  /missionApprovals\.length > 2/,
  "Home should only render approval overflow disclosure when more than two approvals are pending",
);
assert.match(
  home,
  /aria-label="More pending approvals"/,
  "approval overflow should remain discoverable in Simple Mode",
);
assert.match(
  home,
  /More approvals · \{missionApprovals\.length - 2\}/,
  "approval overflow should tell the user how many additional decisions are waiting",
);
assert.match(
  home,
  /missionApprovals\.slice\(2\)\.map\(renderApproval\)/,
  "every selected-Thread approval after the first two should remain actionable through the overflow disclosure",
);
assert.match(
  home,
  /\{approval\.missionGoal\}/,
  "overflow approvals should reuse the same human-readable Mission context as default approvals",
);
assert.match(
  home,
  /decideApproval\(approval\.id, "accept"\)/,
  "revealed approvals should retain the Allow action",
);
assert.match(
  home,
  /decideApproval\(approval\.id, "reject"\)/,
  "revealed approvals should retain the Deny action",
);
assert.doesNotMatch(
  home,
  /missionApprovals\.slice\(0, 2\)\.map\(\(approval\) =>/,
  "the old inline two-item-only approval rendering path should not remain",
);

console.log("intent home approval overflow UI tests passed");
