import test from "node:test";
import assert from "node:assert/strict";

import { normalizeLanguage, onOff, trFor, isChinese } from "../dist/src/i18n.js";

test("language helpers switch user-facing text without changing protocol values", () => {
  assert.equal(normalizeLanguage("zh"), "zh-CN");
  assert.equal(normalizeLanguage("ENGLISH"), "en");
  assert.equal(normalizeLanguage("unsupported"), null);
  assert.equal(trFor("en", "Allow", "允许"), "Allow");
  assert.equal(trFor("zh-CN", "Allow", "允许"), "允许");
  assert.equal(onOff(true, "zh-CN"), "开启");
  assert.equal(onOff(false, "en"), "OFF");
});

test("isChinese accepts every alias normalizeLanguage accepts", () => {
  // Before the fix isChinese() only recognised "zh-cn" and "zh" while
  // normalizeLanguage() also accepted "cn" and "chinese", so a config file that
  // said "language": "cn" silently rendered everything in English.
  for (const alias of ["zh", "zh-cn", "cn", "chinese", "ZH-CN", " ChinesE "]) {
    assert.equal(isChinese(alias), true, `expected ${alias} to be Chinese`);
  }
  for (const other of ["en", "english", "ja", "de", "", undefined, null]) {
    assert.equal(isChinese(other), false, `expected ${String(other)} to not be Chinese`);
  }
});
