import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveRgBinary } from "../dist/src/gates/context-gate.js";
import { SKILL_DIRS } from "../dist/src/gates/skill-gate.js";
import { loadConfig } from "../dist/src/config.js";

// P0 field-test regressions (found by running the live extension on Windows)

test("ripgrep resolution finds Pi's bundled rg when PATH lacks it", () => {
  const resolved = resolveRgBinary();
  assert.equal(typeof resolved, "string");
  assert.ok(resolved.length > 0);

  const bundled = path.join(os.homedir(), ".pi", "agent", "bin", process.platform === "win32" ? "rg.exe" : "rg");
  const override = process.env.PI_JEV_RG_PATH?.trim();

  if (override && fs.existsSync(override)) {
    assert.equal(resolved, override);
  } else if (fs.existsSync(bundled)) {
    // The whole point of the fix: never rely on PATH alone.
    assert.equal(resolved, bundled);
  } else {
    assert.equal(resolved, "rg");
  }
});

test("PI_JEV_RG_PATH override wins when it points at a real file", () => {
  const bundled = path.join(os.homedir(), ".pi", "agent", "bin", process.platform === "win32" ? "rg.exe" : "rg");
  if (!fs.existsSync(bundled)) return; // nothing reliable to point at on this machine
  process.env.PI_JEV_RG_PATH = bundled;
  try {
    assert.equal(resolveRgBinary(), bundled);
  } finally {
    delete process.env.PI_JEV_RG_PATH;
  }
});

test("skill discovery scans the pi-hermes-memory skills directory", () => {
  const dirs = SKILL_DIRS.map((dir) => dir.toLowerCase());
  assert.ok(
    dirs.some((dir) => dir.includes(path.join(".pi", "agent", "pi-hermes-memory", "skills").toLowerCase())),
    `SKILL_DIRS should include pi-hermes-memory skills, got: ${dirs.join(", ")}`,
  );
});

test("decision copilot default timeout leaves room for an 8-question batch", () => {
  const config = loadConfig();
  assert.ok(
    config.decisionCopilot.timeoutMs >= 2000,
    `decisionCopilot.timeoutMs should be >= 2000ms for batched questions, got ${config.decisionCopilot.timeoutMs}`,
  );
});
