// Deterministic real-host check: the extension loads under the installed Pi host
// with zero extension errors and registers its model-invoked tools.
// Requires @earendil-works/pi-coding-agent (tested on 1.0.0). No model calls.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "jev-host-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = dir;
let session;
try {
  const host = await import("@earendil-works/pi-coding-agent");
  const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, ModelRuntime } = host;
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const entryPath = fileURLToPath(new URL("../extensions/index.ts", import.meta.url));
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [entryPath],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json") });
  ({ session } = await createAgentSession({
    cwd: dir, agentDir: dir, settingsManager, modelRuntime, resourceLoader: loader,
    sessionManager: SessionManager.inMemory(dir),
  }));
  const errors = [];
  session.extensionRunner.onError((event) => errors.push(event));
  await session.bindExtensions({});
  const toolNames = session.agent.state.tools.map((tool) => tool.name);
  const expected = [
    "jev_assess_task", "jev_assess_risk", "jev_diagnose_failure", "jev_request_model_tier",
    "jev_prune_context", "jev_memory_add", "jev_rank", "jev_memory_search",
  ];
  for (const name of expected) {
    assert.ok(toolNames.includes(name), `tool ${name} is registered`);
  }
  assert.ok(session.agent.state.tools.every((tool) => tool.name !== "jev" ), "/jev is a command, not a tool");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, entryPath, checks: ["extension loads with zero errors", "model-invoked jev_* tools registered", "extension bind is error-free"], modelCalls: 0 }, null, 2));
} finally {
  session?.dispose();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(dir, { recursive: true, force: true });
}
