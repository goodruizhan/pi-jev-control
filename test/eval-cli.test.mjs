import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { TOOL_GATE_QUESTION } from "../dist/src/judge/questions.js";

const configUrl = new URL("../dist/src/config.js", import.meta.url).href;
const runnerUrl = new URL("./eval-backends.mjs", import.meta.url).href;

test("eval CLI resolves a live reference for an unlabeled dataset without network", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-eval-cli-"));
  try {
    const dataset = join(dir, "cases.jsonl");
    writeFileSync(dataset, JSON.stringify({
      state: { tool_name: "read", input: { path: "README.md" } },
      answers: {},
      questions: { tool_gate: TOOL_GATE_QUESTION },
    }) + "\n");
    const code = `
      const { resetConfigToDefaults } = await import(${JSON.stringify(configUrl)});
      resetConfigToDefaults();
      globalThis.fetch = async () => { throw new Error("Network forbidden in this test"); };
      process.argv = [process.execPath, "eval-backends.mjs", "--dataset", ${JSON.stringify(dataset)}, "--backends", "rules", "--reference", "rules"];
      await import(${JSON.stringify(runnerUrl)});
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 15000 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /1\/1\s+100\.0%/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
