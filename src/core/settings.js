"use strict";

const CHANNEL_IDS = ["wechat", "feishu", "dingtalk", "wecom", "qq", "slack", "telegram", "discord", "whatsapp"];

const CHANNEL_META = {
  wechat: { name: "微信", mark: "微", color: "#22a559", setup: "扫码连接" },
  feishu: { name: "飞书 / Lark", mark: "飞", color: "#3370ff", setup: "扫码创建应用或填写凭据" },
  dingtalk: { name: "钉钉", mark: "钉", color: "#1677ff", setup: "应用凭据" },
  wecom: { name: "企业微信", mark: "企", color: "#07c160", setup: "智能机器人凭据" },
  qq: { name: "QQ", mark: "Q", color: "#12b7f5", setup: "QQ 开放平台凭据" },
  slack: { name: "Slack", mark: "S", color: "#611f69", setup: "Socket Mode 令牌" },
  telegram: { name: "Telegram", mark: "T", color: "#229ed9", setup: "BotFather 令牌" },
  discord: { name: "Discord", mark: "D", color: "#5865f2", setup: "Bot 令牌" },
  whatsapp: { name: "WhatsApp", mark: "W", color: "#25d366", setup: "扫码连接" },
};

const DEFAULT_SETTINGS = {
  schemaVersion: 1,
  storage: {
    diaryFolder: "Omnichannel Diary/Daily",
    clippingFolder: "Omnichannel Diary/Clippings",
    attachmentFolder: "Omnichannel Diary/Attachments",
    addSourceMetadata: true,
  },
  capture: {
    autoClipLinks: true,
    downloadWebImages: true,
    downloadChatAttachments: true,
    maxFileMb: 20,
    includeGroupMessages: true,
    requireMentionInGroups: false,
  },
  channels: {
    wechat: { enabled: false, token: "", accountId: "", userId: "", baseUrl: "https://ilinkai.weixin.qq.com", syncBuf: "" },
    feishu: { enabled: false, appId: "", appSecret: "", domain: "feishu" },
    dingtalk: { enabled: false, clientId: "", clientSecret: "" },
    wecom: { enabled: false, botId: "", secret: "" },
    qq: { enabled: false, appId: "", appSecret: "", sandbox: false },
    slack: { enabled: false, appToken: "", botToken: "" },
    telegram: { enabled: false, botToken: "", offset: 0 },
    discord: { enabled: false, botToken: "" },
    whatsapp: { enabled: false },
  },
  runtime: { recentMessageIds: [] },
};

function deepMerge(defaults, saved) {
  if (Array.isArray(defaults)) return Array.isArray(saved) ? saved : [...defaults];
  if (!defaults || typeof defaults !== "object") return saved === undefined ? defaults : saved;
  const output = {};
  for (const [key, value] of Object.entries(defaults)) {
    output[key] = deepMerge(value, saved && typeof saved === "object" ? saved[key] : undefined);
  }
  return output;
}

function sanitizeFolder(value, fallback) {
  const cleaned = String(value || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\.{2,}/g, ".").trim();
  return cleaned || fallback;
}

function normalizeSettings(saved) {
  const source = saved?.schemaVersion === 1 ? saved : migrateLegacySettings(saved || {});
  const value = deepMerge(DEFAULT_SETTINGS, source);
  value.storage.diaryFolder = sanitizeFolder(value.storage.diaryFolder, DEFAULT_SETTINGS.storage.diaryFolder);
  value.storage.clippingFolder = sanitizeFolder(value.storage.clippingFolder, DEFAULT_SETTINGS.storage.clippingFolder);
  value.storage.attachmentFolder = sanitizeFolder(value.storage.attachmentFolder, DEFAULT_SETTINGS.storage.attachmentFolder);
  value.capture.maxFileMb = Math.min(100, Math.max(1, Number(value.capture.maxFileMb) || 20));
  value.runtime.recentMessageIds = Array.isArray(value.runtime.recentMessageIds) ? value.runtime.recentMessageIds.slice(-500) : [];
  return value;
}

function migrateLegacySettings(saved) {
  const legacySettings = saved.settings || {};
  const legacyChannels = saved.channels || {};
  const ilink = saved.ilink || {};
  const migrated = {
    schemaVersion: 1,
    storage: {
      diaryFolder: legacySettings.diaryFolder || DEFAULT_SETTINGS.storage.diaryFolder,
      clippingFolder: legacySettings.webClipFolder || DEFAULT_SETTINGS.storage.clippingFolder,
      attachmentFolder: DEFAULT_SETTINGS.storage.attachmentFolder,
      addSourceMetadata: legacySettings.includeChannelLabel !== false,
    },
    capture: {
      autoClipLinks: legacySettings.webClipEnabled !== false,
      downloadWebImages: legacySettings.webClipSaveImages !== false,
      downloadChatAttachments: legacySettings.saveVoiceAudio !== false,
      maxFileMb: Number(legacySettings.webClipMaxTotalImageMb) || DEFAULT_SETTINGS.capture.maxFileMb,
      includeGroupMessages: true,
      requireMentionInGroups: false,
    },
    channels: {
      wechat: {
        enabled: Boolean(ilink.botTokenFallback),
        token: ilink.botTokenFallback || "",
        accountId: ilink.botId || "",
        userId: ilink.userId || "",
        baseUrl: ilink.baseUrl || DEFAULT_SETTINGS.channels.wechat.baseUrl,
        syncBuf: ilink.buf || "",
      },
      feishu: { enabled: Boolean(legacyChannels.feishu?.enabled), appId: legacyChannels.feishu?.appId || "", appSecret: "", domain: "feishu" },
      dingtalk: { enabled: Boolean(legacyChannels.dingtalk?.enabled), clientId: legacyChannels.dingtalk?.clientId || "", clientSecret: "" },
      wecom: { enabled: Boolean(legacyChannels.wecom?.enabled), botId: legacyChannels.wecom?.remoteBotId || "", secret: "" },
      qq: { enabled: Boolean(legacyChannels.qq?.enabled), appId: legacyChannels.qq?.appId || "", appSecret: "", sandbox: false },
      slack: { enabled: Boolean(legacyChannels.slack?.enabled), appToken: "", botToken: "" },
      telegram: { enabled: Boolean(legacyChannels.telegram?.enabled), botToken: "", offset: 0 },
      discord: { enabled: Boolean(legacyChannels.discord?.enabled), botToken: "" },
      whatsapp: { enabled: Boolean(legacyChannels.whatsapp?.enabled) },
    },
    runtime: { recentMessageIds: [] },
  };
  return migrated;
}

function clearChannelCredentials(settings, channelId) {
  settings.channels[channelId] = deepMerge(DEFAULT_SETTINGS.channels[channelId], {});
}

module.exports = { CHANNEL_IDS, CHANNEL_META, DEFAULT_SETTINGS, clearChannelCredentials, migrateLegacySettings, normalizeSettings };
