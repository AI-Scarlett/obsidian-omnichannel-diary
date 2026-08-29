"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { CHANNEL_IDS, DEFAULT_SETTINGS, clearChannelCredentials, migrateLegacySettings, normalizeSettings } = require("../src/core/settings");

test("clean settings expose exactly nine channels and no model configuration", () => {
  assert.equal(CHANNEL_IDS.length, 9);
  assert.deepEqual(Object.keys(DEFAULT_SETTINGS.channels), CHANNEL_IDS);
  assert.equal(JSON.stringify(DEFAULT_SETTINGS).match(/openai|anthropic|model|prompt/gi), null);
});

test("saved values are merged, folders normalized, and unknown inherited keys dropped", () => {
  const settings = normalizeSettings({
    schemaVersion: 1,
    storage: { diaryFolder: "/Notes\\Diary/" },
    capture: { maxFileMb: 500 },
    channels: { telegram: { enabled: true, botToken: "secret" } },
    inheritedLegacyKey: "must disappear",
  });
  assert.equal(settings.storage.diaryFolder, "Notes/Diary");
  assert.equal(settings.capture.maxFileMb, 100);
  assert.equal(settings.channels.telegram.botToken, "secret");
  assert.equal(settings.inheritedLegacyKey, undefined);
});

test("clearing a channel resets credentials and disables it", () => {
  const settings = normalizeSettings({ channels: { slack: { enabled: true, appToken: "xapp-a", botToken: "xoxb-b" } } });
  clearChannelCredentials(settings, "slack");
  assert.deepEqual(settings.channels.slack, DEFAULT_SETTINGS.channels.slack);
});

test("legacy data keeps user folders and WeChat authorization while removing obsolete model settings", () => {
  const migrated = migrateLegacySettings({
    settings: { diaryFolder: "旧日记", webClipFolder: "旧剪藏", aiApiUrl: "https://unused.invalid", aiModel: "unused" },
    ilink: { botTokenFallback: "wechat-token", botId: "bot", baseUrl: "https://ilinkai.weixin.qq.com", buf: "cursor" },
  });
  const settings = normalizeSettings(migrated);
  assert.equal(settings.storage.diaryFolder, "旧日记");
  assert.equal(settings.storage.clippingFolder, "旧剪藏");
  assert.equal(settings.channels.wechat.token, "wechat-token");
  assert.equal(settings.channels.wechat.enabled, true);
  assert.equal(JSON.stringify(settings).includes("unused"), false);
});

test("channels with incomplete required credentials are not left enabled", () => {
  const settings = normalizeSettings({
    schemaVersion: 1,
    channels: {
      wechat: { enabled: true, token: "" },
      feishu: { enabled: true, appId: "cli_valid", appSecret: "" },
      telegram: { enabled: true, botToken: "valid" },
      whatsapp: { enabled: true },
    },
  });
  assert.equal(settings.channels.wechat.enabled, false);
  assert.equal(settings.channels.feishu.enabled, false);
  assert.equal(settings.channels.telegram.enabled, true);
  assert.equal(settings.channels.whatsapp.enabled, true);
});
