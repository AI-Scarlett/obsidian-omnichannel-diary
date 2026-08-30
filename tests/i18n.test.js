"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeLanguagePreference, resolveLocale, translate } = require("../src/core/i18n");
const { getChannelMeta } = require("../src/core/settings");

test("language preference supports auto, Simplified Chinese, and English", () => {
  assert.equal(normalizeLanguagePreference("zh-cn"), "zh-CN");
  assert.equal(normalizeLanguagePreference("en-US"), "en");
  assert.equal(normalizeLanguagePreference("unsupported"), "auto");
  assert.equal(resolveLocale("auto", "zh-cn"), "zh-CN");
  assert.equal(resolveLocale("auto", "fr"), "en");
  assert.equal(resolveLocale("zh-CN", "en"), "zh-CN");
});

test("translations interpolate values and channel metadata follows the selected language", () => {
  assert.equal(translate("zh-CN", "已保存 {count} 张", "Saved {count}", { count: 2 }), "已保存 2 张");
  assert.equal(translate("en", "已保存 {count} 张", "Saved {count}", { count: 2 }), "Saved 2");
  assert.equal(getChannelMeta("wechat", "zh-CN").name, "微信");
  assert.equal(getChannelMeta("wechat", "en").name, "WeChat");
  assert.equal(getChannelMeta("wechat", "en").mark, "W");
  assert.match(getChannelMeta("whatsapp", "en").setup, /linked-device/i);
});
