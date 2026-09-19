import test from "node:test";
import assert from "node:assert/strict";

import { setupContextGate } from "../dist/src/gates/context-gate.js";
import { loadConfig } from "../dist/src/config.js";
import { resetClient } from "../dist/src/jev/client.js";

test("context search returns real path, line, and preview on Windows", async () => {
  const originalKey = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  resetClient();

  let tool;
  setupContextGate({ registerTool: (definition) => { tool = definition; } });
  const config = loadConfig();
  config.enabled = true;
  config.contextGate.enabled = true;

  const result = await tool.execute(
    "search-1",
    { query: "classifyShellCommand", roots: [process.cwd()], maxResults: 5 },
    undefined,
    undefined,
    { signal: undefined },
  );
  const text = result.content[0].text;
  assert.match(text, /src[\\/]gates[\\/]tool-gate\.ts/);
  assert.match(text, /line: \d+/);
  assert.match(text, /preview:/);

  if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = originalKey;
  resetClient();
});

test("context search rejects roots outside the current project", async () => {
  let tool;
  setupContextGate({ registerTool: (definition) => { tool = definition; } });
  const config = loadConfig();
  config.enabled = true;
  config.contextGate.enabled = true;

  const result = await tool.execute(
    "search-2",
    { query: "anything", roots: [".."] },
    undefined,
    undefined,
    { signal: undefined },
  );
  assert.match(result.content[0].text, /outside the current project/);
});
