"use strict";

const { parseXStatusUrl } = require("./xclip");
const { isXiaohongshuUrl } = require("./xhsclip");
const { communityServiceForUrl, documentServiceForUrl, isLikelyPdfUrl } = require("./web-platforms");

const CLIP_FAMILY_IDS = ["articles", "social", "community", "documents", "pdfs"];

const CLIP_FAMILIES = {
  articles: {
    id: "articles",
    zh: "普通网页",
    en: "Articles",
    defaultFolder: "Articles",
    zhDesc: "新闻、博客和未能归入其他类型的网页",
    enDesc: "News, blogs, and pages that do not match another type",
  },
  social: {
    id: "social",
    zh: "社交内容",
    en: "Social",
    defaultFolder: "Social",
    zhDesc: "X / Twitter、微信公众号、小红书",
    enDesc: "X / Twitter, WeChat articles, and Xiaohongshu / REDnote",
  },
  community: {
    id: "community",
    zh: "技术社区",
    en: "Community",
    defaultFolder: "Community",
    zhDesc: "论坛、问答、Issue / PR 和带评论的帖子",
    enDesc: "Forums, Q&A, issues / PRs, and posts with comments",
  },
  documents: {
    id: "documents",
    zh: "云文档",
    en: "Cloud documents",
    defaultFolder: "Documents",
    zhDesc: "飞书 / Lark、腾讯文档、WPS、Google Docs / Sheets / Slides、Microsoft 365 / OneDrive",
    enDesc: "Feishu / Lark, Tencent Docs, WPS, Google Docs / Sheets / Slides, and Microsoft 365 / OneDrive",
  },
  pdfs: {
    id: "pdfs",
    zh: "PDF",
    en: "PDFs",
    defaultFolder: "PDFs",
    zhDesc: "在线 PDF 和聊天里的 PDF 附件",
    enDesc: "Online PDFs and PDF attachments from chat",
  },
};

function defaultClipRules() {
  return Object.fromEntries(CLIP_FAMILY_IDS.map((id) => [id, {
    enabled: true,
    folder: CLIP_FAMILIES[id].defaultFolder,
  }]));
}

function sanitizeSubfolder(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.{2,}/g, ".")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("/");
}

function normalizeClipRules(saved) {
  const defaults = defaultClipRules();
  const source = saved && typeof saved === "object" ? saved : {};
  const output = {};
  for (const id of CLIP_FAMILY_IDS) {
    const incoming = source[id] && typeof source[id] === "object" ? source[id] : {};
    output[id] = {
      enabled: incoming.enabled !== false,
      folder: Object.prototype.hasOwnProperty.call(incoming, "folder")
        ? sanitizeSubfolder(incoming.folder)
        : defaults[id].folder,
    };
  }
  return output;
}

function isWeChatArticleUrl(value) {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, "") === "mp.weixin.qq.com";
  } catch (_) {
    return false;
  }
}

function classifyClipFamily(url, article = null) {
  const raw = String(article?.url || url || "");
  const method = String(article?.extractionMethod || "");
  if (
    raw.startsWith("attachment:")
    || method === "pdf-text"
    || /pdf/i.test(method)
    || isLikelyPdfUrl(raw)
  ) return "pdfs";
  if (documentServiceForUrl(raw) || method.includes("rendered-document")) return "documents";
  if (parseXStatusUrl(raw) || isXiaohongshuUrl(raw) || isWeChatArticleUrl(raw)
    || method.includes("xiaohongshu") || method.includes("wechat-article") || /^x-/.test(method)) {
    return "social";
  }
  if (
    communityServiceForUrl(raw)
    || Number(article?.commentCount) > 0
    || method.includes("comment")
    || method.includes("community")
  ) return "community";
  return "articles";
}

function isClipFamilyEnabled(settings, family) {
  const id = CLIP_FAMILIES[family] ? family : "articles";
  const rules = normalizeClipRules(settings?.capture?.clipRules);
  return rules[id].enabled !== false;
}

function resolveClipFolder(settings, family) {
  const id = CLIP_FAMILIES[family] ? family : "articles";
  const root = String(settings?.storage?.clippingFolder || "Omnichannel Diary/Clippings")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  const subfolder = normalizeClipRules(settings?.capture?.clipRules)[id].folder;
  return subfolder ? `${root}/${subfolder}` : root;
}

function clipFamilyLabel(family, locale = "zh-CN") {
  const meta = CLIP_FAMILIES[family] || CLIP_FAMILIES.articles;
  return locale === "en" ? meta.en : meta.zh;
}

module.exports = {
  CLIP_FAMILIES,
  CLIP_FAMILY_IDS,
  classifyClipFamily,
  clipFamilyLabel,
  defaultClipRules,
  isClipFamilyEnabled,
  isWeChatArticleUrl,
  normalizeClipRules,
  resolveClipFolder,
  sanitizeSubfolder,
};
