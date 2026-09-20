import test from "node:test";
import assert from "node:assert/strict";

import { normalizeLanguage, onOff, trFor } from "../dist/src/i18n.js";

test("language helpers switch user-facing text without changing protocol values", () => {
  assert.equal(normalizeLanguage("zh"), "zh-CN");
  assert.equal(normalizeLanguage("ENGLISH"), "en");
  assert.equal(normalizeLanguage("unsupported"), null);
  assert.equal(trFor("en", "Allow", "允许"), "Allow");
  assert.equal(trFor("zh-CN", "Allow", "允许"), "允许");
  assert.equal(onOff(true, "zh-CN"), "开启");
  assert.equal(onOff(false, "en"), "OFF");
});
