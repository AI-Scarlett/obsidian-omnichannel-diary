"use strict";

const { normalizeLanguagePreference } = require("./i18n");
const { normalizeAdditionalHosts, normalizeCodePlatformMode } = require("./code-platforms");
const { normalizeRemoteSearchSettings } = require("./remote-search");

const CHANNEL_IDS = ["wechat", "feishu", "dingtalk", "wecom", "qq", "slack", "telegram", "discord", "whatsapp"];

const CHANNEL_META = {
  wechat: { name: "微信", enName: "WeChat", mark: "微", enMark: "W", setup: "官方扫码授权", enSetup: "Official QR authorization" },
  feishu: { name: "飞书 / Lark", enName: "Feishu / Lark", mark: "飞", enMark: "F", setup: "官方扫码创建应用 / 应用凭据", enSetup: "Official QR app setup / credentials" },
  dingtalk: { name: "钉钉", enName: "DingTalk", mark: "钉", enMark: "D", setup: "官方应用凭据", enSetup: "Official app credentials" },
  wecom: { name: "企业微信", enName: "WeCom", mark: "企", enMark: "W", setup: "官方机器人凭据", enSetup: "Official bot credentials" },
  qq: { name: "QQ", enName: "QQ", mark: "Q", enMark: "Q", setup: "官方开放平台凭据", enSetup: "Official Open Platform credentials" },
  slack: { name: "Slack", enName: "Slack", mark: "S", enMark: "S", setup: "官方 Socket Mode 令牌", enSetup: "Official Socket Mode tokens" },
  telegram: { name: "Telegram", enName: "Telegram", mark: "T", enMark: "T", setup: "官方 BotFather 令牌", enSetup: "Official BotFather token" },
  discord: { name: "Discord", enName: "Discord", mark: "D", enMark: "D", setup: "官方 Bot 令牌", enSetup: "Official bot token" },
  whatsapp: { name: "WhatsApp", enName: "WhatsApp", mark: "W", enMark: "W", setup: "官方关联设备扫码", enSetup: "Official linked-device QR" },
};

function getChannelMeta(id, locale = "zh-CN") {
  const meta = CHANNEL_META[id];
  if (!meta) return { name: id, setup: "", mark: "?" };
  return {
    ...meta,
    name: locale === "en" ? meta.enName : meta.name,
    mark: locale === "en" ? meta.enMark : meta.mark,
    setup: locale === "en" ? meta.enSetup : meta.setup,
  };
}

const REQUIRED_CREDENTIALS = {
  wechat: ["token"],
  feishu: ["appId", "appSecret"],
  dingtalk: ["clientId", "clientSecret"],
  wecom: ["botId", "secret"],
  qq: ["appId", "appSecret"],
  slack: ["appToken", "botToken"],
  telegram: ["botToken"],
  discord: ["botToken"],
};

const DEFAULT_SETTINGS = {
  schemaVersion: 1,
  ui: { language: "auto" },
  storage: {
    diaryFolder: "Omnichannel Diary/Daily",
    clippingFolder: "Omnichannel Diary/Clippings",
    codePlatformFolder: "Omnichannel Diary/Code Links",
    attachmentFolder: "Omnichannel Diary/Attachments",
    addSourceMetadata: true,
  },
  capture: {
    autoClipLinks: true,
    codePlatformMode: "extract",
    codePlatformAdditionalHosts: "",
    downloadWebImages: true,
    renderDynamicPages: true,
    browserExecutable: "",
    downloadChatAttachments: true,
    maxFileMb: 20,
    maxWebImages: 30,
    maxWebImageTotalMb: 50,
    webClipBudgetSeconds: 75,
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
    whatsapp: { enabled: false, nodePath: "" },
  },
  remoteSearch: {
    enabled: false,
    folder: "",
    exportFormat: "md",
  },
  runtime: { recentMessageIds: [], pendingReceipts: [], remoteQueries: [] },
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
  value.storage.codePlatformFolder = sanitizeFolder(value.storage.codePlatformFolder, DEFAULT_SETTINGS.storage.codePlatformFolder);
  value.storage.attachmentFolder = sanitizeFolder(value.storage.attachmentFolder, DEFAULT_SETTINGS.storage.attachmentFolder);
  value.capture.codePlatformMode = normalizeCodePlatformMode(value.capture.codePlatformMode);
  value.capture.codePlatformAdditionalHosts = normalizeAdditionalHosts(value.capture.codePlatformAdditionalHosts).join(", ");
  value.capture.maxFileMb = Math.min(100, Math.max(1, Number(value.capture.maxFileMb) || 20));
  value.capture.maxWebImages = Math.min(100, Math.max(1, Number(value.capture.maxWebImages) || 30));
  value.capture.maxWebImageTotalMb = Math.min(500, Math.max(1, Number(value.capture.maxWebImageTotalMb) || 50));
  value.capture.webClipBudgetSeconds = Math.min(180, Math.max(15, Number(value.capture.webClipBudgetSeconds) || 75));
  value.capture.browserExecutable = String(value.capture.browserExecutable || "").trim();
  value.ui.language = normalizeLanguagePreference(value.ui.language);
  value.runtime.recentMessageIds = Array.isArray(value.runtime.recentMessageIds) ? value.runtime.recentMessageIds.slice(-500) : [];
  value.runtime.pendingReceipts = Array.isArray(value.runtime.pendingReceipts)
    ? value.runtime.pendingReceipts.filter((item) => item && typeof item.id === "string" && typeof item.text === "string").slice(-100)
    : [];
  normalizeRemoteSearchSettings(value);
  for (const [id, fields] of Object.entries(REQUIRED_CREDENTIALS)) {
    if (value.channels[id].enabled && fields.some((field) => !String(value.channels[id][field] || "").trim())) {
      value.channels[id].enabled = false;
    }
  }
  return value;
}

function migrateLegacySettings(saved) {
  const legacySettings = saved.settings || {};
  const legacyChannels = saved.channels || {};
  const ilink = saved.ilink || {};
  const migrated = {
    schemaVersion: 1,
    ui: { language: "auto" },
    storage: {
      diaryFolder: legacySettings.diaryFolder || DEFAULT_SETTINGS.storage.diaryFolder,
      clippingFolder: legacySettings.webClipFolder || DEFAULT_SETTINGS.storage.clippingFolder,
      codePlatformFolder: DEFAULT_SETTINGS.storage.codePlatformFolder,
      attachmentFolder: DEFAULT_SETTINGS.storage.attachmentFolder,
      addSourceMetadata: legacySettings.includeChannelLabel !== false,
    },
    capture: {
      autoClipLinks: legacySettings.webClipEnabled !== false,
      codePlatformMode: "extract",
      codePlatformAdditionalHosts: "",
      downloadWebImages: legacySettings.webClipSaveImages !== false,
      renderDynamicPages: true,
      browserExecutable: "",
      downloadChatAttachments: legacySettings.saveVoiceAudio !== false,
      maxFileMb: Number(legacySettings.webClipMaxTotalImageMb) || DEFAULT_SETTINGS.capture.maxFileMb,
      maxWebImages: Number(legacySettings.webClipMaxImages) || DEFAULT_SETTINGS.capture.maxWebImages,
      maxWebImageTotalMb: Number(legacySettings.webClipMaxTotalImageMb) || DEFAULT_SETTINGS.capture.maxWebImageTotalMb,
      webClipBudgetSeconds: DEFAULT_SETTINGS.capture.webClipBudgetSeconds,
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
      whatsapp: { enabled: Boolean(legacyChannels.whatsapp?.enabled), nodePath: "" },
    },
    remoteSearch: {
      enabled: false,
      folder: "",
      exportFormat: "md",
    },
    runtime: { recentMessageIds: [], pendingReceipts: [], remoteQueries: [] },
  };
  return migrated;
}

function clearChannelCredentials(settings, channelId) {
  settings.channels[channelId] = deepMerge(DEFAULT_SETTINGS.channels[channelId], {});
}

module.exports = { CHANNEL_IDS, CHANNEL_META, DEFAULT_SETTINGS, clearChannelCredentials, getChannelMeta, migrateLegacySettings, normalizeSettings };
