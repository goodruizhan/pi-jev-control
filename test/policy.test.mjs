import test from "node:test";
import assert from "node:assert/strict";

import { resolveJevGatePolicy } from "../dist/src/gates/tool-gate.js";

test("low-confidence tool decisions do not prompt by default", () => {
  assert.equal(resolveJevGatePolicy("allow", 0.4, false), "allow");
  assert.equal(resolveJevGatePolicy("deny", 0.4, false), "allow");
  assert.equal(resolveJevGatePolicy("confirm", 0.4, false), "allow");
});

test("strict policy keeps confirmations and confident denials", () => {
  assert.equal(resolveJevGatePolicy("confirm", 0.4, true), "confirm");
  assert.equal(resolveJevGatePolicy("deny", 0.7, false), "deny");
  assert.equal(resolveJevGatePolicy("allow", 0.85, true), "allow");
});
