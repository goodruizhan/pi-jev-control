import test from "node:test";
import assert from "node:assert/strict";

import { applyPruning, buildToolGroups } from "../dist/src/compaction/pruner.js";
import {
  advanceTurn,
  clearEpochPlan,
  consumeSkipNextGeneration,
  resetEpoch,
  setEpochPlan,
  shouldGeneratePlan,
} from "../dist/src/compaction/epoch.js";

function multiToolMessages() {
  const assistant = {
    role: "assistant",
    content: [
      { type: "toolCall", id: "call-a", name: "read", arguments: { path: "a.ts" } },
      { type: "toolCall", id: "call-b", name: "read", arguments: { path: "b.ts" } },
    ],
  };
  const resultA = {
    role: "toolResult",
    toolCallId: "call-a",
    toolName: "read",
    content: [{ type: "text", text: "A" }],
    isError: false,
  };
  const resultB = {
    role: "toolResult",
    toolCallId: "call-b",
    toolName: "read",
    content: [{ type: "text", text: "B" }],
    isError: false,
  };
  return [assistant, resultA, resultB];
}

test("parallel tool calls form one atomic pruning group", () => {
  const messages = multiToolMessages();
  const { groups } = buildToolGroups(messages);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].resultEntries.length, 2);
  assert.match(groups[0].inputSummary, /a\.ts/);
  assert.match(groups[0].inputSummary, /b\.ts/);

  const plan = {
    epochId: "test",
    createdAtTurn: 0,
    keepIds: new Set(),
    truncateIds: new Set(),
    dropIds: new Set([groups[0].groupId]),
    estimatedCharsBefore: 1,
    estimatedCharsAfter: 0,
  };
  assert.deepEqual(applyPruning(messages, plan, groups), []);
});

test("epoch regeneration is based on actual turns", () => {
  resetEpoch();
  const plan = {
    epochId: "epoch",
    createdAtTurn: 0,
    keepIds: new Set(),
    truncateIds: new Set(),
    dropIds: new Set(),
    estimatedCharsBefore: 0,
    estimatedCharsAfter: 0,
  };
  setEpochPlan(plan);
  assert.equal(shouldGeneratePlan(2), false);
  advanceTurn();
  assert.equal(shouldGeneratePlan(2), false);
  advanceTurn();
  assert.equal(shouldGeneratePlan(2), true);

  clearEpochPlan();
  assert.equal(consumeSkipNextGeneration(), true);
  assert.equal(consumeSkipNextGeneration(), false);
});
