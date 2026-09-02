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
    storage: { diaryFolder: "/Notes\\Diary/", codePlatformFolder: "/Dev\\Links/" },
    capture: {
      maxFileMb: 500, maxWebImages: 999, maxWebImageTotalMb: 999, webClipBudgetSeconds: 2,
      codePlatformMode: "bookmark", codePlatformAdditionalHosts: "https://git.example.com/a, code.example.org",
    },
    channels: { telegram: { enabled: true, botToken: "secret" } },
    inheritedLegacyKey: "must disappear",
  });
  assert.equal(settings.storage.diaryFolder, "Notes/Diary");
  assert.equal(settings.storage.codePlatformFolder, "Dev/Links");
  assert.equal(settings.capture.maxFileMb, 100);
  assert.equal(settings.capture.maxWebImages, 100);
  assert.equal(settings.capture.maxWebImageTotalMb, 500);
  assert.equal(settings.capture.webClipBudgetSeconds, 15);
  assert.equal(settings.capture.codePlatformMode, "bookmark");
  assert.equal(settings.capture.codePlatformAdditionalHosts, "git.example.com, code.example.org");
  assert.equal(settings.channels.telegram.botToken, "secret");
  assert.equal(settings.inheritedLegacyKey, undefined);
  assert.deepEqual(settings.runtime.pendingReceipts, []);
  assert.deepEqual(settings.runtime.remoteQueries, []);
  assert.equal(settings.remoteSearch.enabled, false);
  assert.equal(settings.remoteSearch.exportFormat, "md");
  assert.equal(settings.ui.language, "auto");
  assert.equal(settings.capture.renderDynamicPages, true);
  assert.equal(settings.capture.browserExecutable, "");
  assert.equal(settings.capture.clipRules.articles.enabled, true);
  assert.equal(settings.capture.clipRules.social.folder, "Social");
  assert.equal(settings.capture.includeGroupMessages, undefined);
  assert.equal(settings.capture.requireMentionInGroups, undefined);
});

test("clipping type rules keep unknown families out and sanitize subfolders", () => {
  const settings = normalizeSettings({
    schemaVersion: 1,
    capture: {
      clipRules: {
        articles: { enabled: false, folder: "/News\\Blogs/" },
        pdfs: { enabled: "no", folder: "../escape" },
        mystery: { enabled: true, folder: "Nope" },
      },
    },
  });
  assert.equal(settings.capture.clipRules.articles.enabled, false);
  assert.equal(settings.capture.clipRules.articles.folder, "News/Blogs");
  assert.equal(settings.capture.clipRules.social.enabled, true);
  assert.equal(settings.capture.clipRules.social.folder, "Social");
  assert.equal(settings.capture.clipRules.pdfs.enabled, true);
  assert.equal(settings.capture.clipRules.pdfs.folder, "escape");
  assert.equal(settings.capture.clipRules.mystery, undefined);
});

test("new web clipping limits default to a bounded message budget", () => {
  const settings = normalizeSettings({ schemaVersion: 1 });
  assert.equal(settings.capture.maxWebImages, 30);
  assert.equal(settings.capture.maxWebImageTotalMb, 50);
  assert.equal(settings.capture.webClipBudgetSeconds, 75);
});

test("new code-platform settings keep existing installs on extraction mode", () => {
  const settings = normalizeSettings({ schemaVersion: 1, storage: { diaryFolder: "日记" } });
  assert.equal(settings.storage.codePlatformFolder, "Omnichannel Diary/Code Links");
  assert.equal(settings.capture.codePlatformMode, "extract");
  assert.equal(settings.capture.codePlatformAdditionalHosts, "");
  assert.equal(normalizeSettings({ schemaVersion: 1, capture: { codePlatformMode: "delete" } }).capture.codePlatformMode, "extract");
});

test("language choice is preserved and invalid values fall back to Obsidian auto detection", () => {
  assert.equal(normalizeSettings({ schemaVersion: 1, ui: { language: "en" } }).ui.language, "en");
  assert.equal(normalizeSettings({ schemaVersion: 1, ui: { language: "zh-cn" } }).ui.language, "zh-CN");
  assert.equal(normalizeSettings({ schemaVersion: 1, ui: { language: "de" } }).ui.language, "auto");
});

test("remote search settings stay off by default and drop expired sessions", () => {
  const settings = normalizeSettings({
    schemaVersion: 1,
    remoteSearch: { enabled: "yes", folder: "/Notes\\Research/", exportFormat: "pdfx" },
    runtime: { remoteQueries: [
      { id: "Q0902-AAAA", ownerKey: "wechat:u1", keyword: "ai", expiresAt: Date.now() + 60_000, candidates: [{ path: "a.md", title: "A", time: "t", source: "s", mtime: 1, content: "secret" }] },
      { id: "Q0902-BBBB", ownerKey: "wechat:u1", keyword: "old", expiresAt: Date.now() - 1, candidates: [{ path: "b.md" }] },
    ] },
  });
  assert.equal(settings.remoteSearch.enabled, false);
  assert.equal(settings.remoteSearch.folder, "Notes/Research");
  assert.equal(settings.remoteSearch.exportFormat, "md");
  assert.equal(settings.runtime.remoteQueries.length, 1);
  assert.equal(settings.runtime.remoteQueries[0].id, "Q0902-AAAA");
  assert.equal(settings.runtime.remoteQueries[0].candidates[0].content, undefined);
});

test("pending receipts are sanitized and bounded for retry after restart", () => {
  const pendingReceipts = Array.from({ length: 105 }, (_, index) => ({ id: `wechat:${index}`, text: `receipt ${index}`, ignored: true }));
  pendingReceipts.push({ id: 42, text: "invalid" });
  const settings = normalizeSettings({ schemaVersion: 1, runtime: { pendingReceipts } });
  assert.equal(settings.runtime.pendingReceipts.length, 100);
  assert.equal(settings.runtime.pendingReceipts[0].id, "wechat:5");
  assert.equal(settings.runtime.pendingReceipts.at(-1).text, "receipt 104");
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
  assert.equal(settings.storage.codePlatformFolder, DEFAULT_SETTINGS.storage.codePlatformFolder);
  assert.equal(settings.capture.codePlatformMode, "extract");
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
