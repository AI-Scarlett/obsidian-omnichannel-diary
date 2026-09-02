"use strict";

const { translate } = require("./i18n");
const { extractUrls } = require("./util");
const { getChannelMeta } = require("./settings");
const {
  formatRemoteAckText,
  formatRemoteCancelText,
  formatRemoteDisabledText,
  formatRemoteExportReceipt,
  formatRemoteHelpText,
  parseRemoteCommand,
  stripRemoteCommandNoise,
} = require("./remote-search");

function displayFolder(value, fallback) {
  return String(value || fallback).replace(/^\/+|\/+$/g, "").trim() || fallback;
}

function folderFromPath(filePath, fallback) {
  const parts = String(filePath || "").replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join("/") : fallback;
}

function displayTitle(value, locale = "zh-CN") {
  const fallback = translate(locale, "未命名网页", "Untitled web page");
  const title = String(value || fallback).replace(/\s+/g, " ").trim() || fallback;
  return title.length > 100 ? `${title.slice(0, 99)}…` : title;
}

function formatAgentGuide(result = {}, locale = "zh-CN") {
  return locale === "en"
    ? "Hi~ I'm your quick-capture Agent ✍️ Send me anything you want to save. If something is wrong, edit it in Obsidian. Send “help” anytime for all commands."
    : "嗨~ 我是你的随手记 Agent ✍️ 想记什么直接发给我，说错了可以直接在 Obsidian 里修改，随时发「帮助」看全部用法。";
}

function formatHelpText(locale = "zh-CN", result = {}) {
  const commands = locale === "en" ? [
    "Available commands:",
    "• Send text, a voice note, an image, or a file: add it to today's note",
    "• Send a web link: extract articles, cloud documents, PDFs, images, technical-community posts, answers, and supported comment threads into a Markdown clipping",
    "• Send a code-platform link: extract it, file it as a categorized bookmark, or do both according to Capture rules",
    "• /clip <URL>: clip only the specified page",
    "• /status: show the current channel connection status",
    "• Remote search needs a space: search keyword. Without the space it is saved as diary text.",
    ...(result.remoteSearchEnabled ? [
      "",
      formatRemoteHelpText({ remoteSearch: { exportFormat: result.remoteExportFormat || "md" } }, "en"),
    ] : []),
  ] : [
    "可用指令：",
    "• 直接发送文字、语音、图片或文件：写入今天的笔记",
    "• 直接发送网页链接：提取文章、云文档、PDF、图片，以及技术社区帖子、问答和支持的评论串，生成 Markdown 剪藏",
    "• 发送代码平台地址：按收集规则提取正文、分类收藏地址，或两者都做",
    "• /clip <链接>：只剪藏指定网页",
    "• /status：查看当前渠道连接状态",
    "• 远程查询必须加空格：查 关键词。写成「查手机卡」会当作普通日记记录。",
    ...(result.remoteSearchEnabled ? [
      "",
      formatRemoteHelpText({ remoteSearch: { exportFormat: result.remoteExportFormat || "md" } }, "zh-CN"),
    ] : []),
  ];
  return [formatAgentGuide(result, locale), "", ...commands].join("\n");
}

const HELP_TEXT = formatHelpText("zh-CN");

function formatCaptureReceipt(result, locale = "zh-CN") {
  const clips = result.clips || [];
  const codeLinks = result.codeLinks || [];
  const clipFailures = result.clipFailures?.length || 0;
  const codeLinkFailures = result.codeLinkFailures?.length || 0;
  const attachmentFailures = result.attachmentFailures?.length || 0;
  const attachmentExtractionFailures = result.attachmentExtractionFailures?.length || 0;
  const savedAttachments = Number(result.savedAttachments) || 0;
  const diaryFallback = translate(locale, "日记", "Daily");
  const clippingFallback = translate(locale, "全渠道剪藏", "Clippings");
  const codePlatformFallback = translate(locale, "代码平台收藏", "Code Links");
  const diaryFolder = displayFolder(result.diaryFolder || folderFromPath(result.diaryPath, diaryFallback), diaryFallback);
  const clippingFolder = displayFolder(result.clippingFolder || folderFromPath(clips[0]?.notePath, clippingFallback), clippingFallback);
  const codePlatformFolder = displayFolder(result.codePlatformFolder || folderFromPath(codeLinks[0]?.notePath, codePlatformFallback), codePlatformFallback);
  const lines = [];

  for (const clip of clips) {
    const title = displayTitle(clip.article?.title, locale);
    const savedImages = Math.max(0, Number(clip.savedImages) || 0);
    const failedImages = clip.imageFailures?.length || 0;
    const savedFiles = Math.max(0, Number(clip.savedFiles) || 0);
    const failedFiles = clip.fileFailures?.length || 0;
    const commentCount = Math.max(0, Number(clip.article?.commentCount) || 0);
    const isPdf = clip.article?.extractionMethod === "pdf-text";
    const pageCount = Math.max(0, Number(clip.article?.pageCount) || 0);
    if (clip.reused && !failedImages && !failedFiles) {
      lines.push(locale === "en"
        ? `🔖 “${title}” was already saved. Reused the clipping in “${clippingFolder}”.`
        : `🔖 《${title}》之前已经保存，已复用「${clippingFolder}」中的剪藏`);
      continue;
    }
    if (isPdf) {
      if (locale === "en") {
        const pages = pageCount ? `${pageCount}-page ` : "";
        if (clip.article?.extractionStatus === "partial") lines.push(`⚠️ “${title}” was saved to “${clippingFolder}”, but only part of the ${pages}PDF text could be extracted.`);
        else lines.push(`🔖 “${title}” was saved to “${clippingFolder}” with the extracted ${pages}PDF text.${savedFiles ? " The original PDF was also saved." : ""}`);
      } else if (clip.article?.extractionStatus === "partial") {
        lines.push(`⚠️ 《${title}》已保存到「${clippingFolder}」，但${pageCount ? ` ${pageCount} 页` : ""} PDF 正文提取不完整`);
      } else {
        lines.push(`🔖 《${title}》已提取${pageCount ? ` ${pageCount} 页` : ""} PDF 正文并保存到「${clippingFolder}」${savedFiles ? "，并保留原 PDF" : ""}`);
      }
      continue;
    }
    const extractedEn = commentCount
      ? `the full text, ${commentCount} comment${commentCount === 1 ? "" : "s"}, and ${savedImages} image${savedImages === 1 ? "" : "s"}`
      : `the full text and ${savedImages} image${savedImages === 1 ? "" : "s"}`;
    const partialEn = commentCount
      ? `the available text, ${commentCount} comment${commentCount === 1 ? "" : "s"}, and ${savedImages} image${savedImages === 1 ? "" : "s"}`
      : `the available text and ${savedImages} image${savedImages === 1 ? "" : "s"}`;
    const extractedZh = commentCount ? `正文、${commentCount} 条评论和 ${savedImages} 张图片` : `正文和 ${savedImages} 张图片`;
    const partialZh = commentCount ? `正文片段、${commentCount} 条评论和 ${savedImages} 张图片` : `正文片段和 ${savedImages} 张图片`;
    const savedFileDetail = savedFiles ? (locale === "en" ? ` The original source file was also saved.` : `，并保留 ${savedFiles} 个原文件`) : "";
    if (locale === "en") {
      if (clip.article?.extractionStatus === "partial") {
        const failed = [];
        if (failedImages) failed.push(`${failedImages} additional image${failedImages === 1 ? "" : "s"}`);
        if (failedFiles) failed.push(`${failedFiles} original file${failedFiles === 1 ? "" : "s"}`);
        const failedDetail = failed.length ? `; ${failed.join(" and ")} failed to save` : "";
        lines.push(`⚠️ “${title}” was only partially extracted. ${partialEn[0].toUpperCase()}${partialEn.slice(1)} were saved to “${clippingFolder}”${failedDetail}.`);
      } else if (failedImages || failedFiles) {
        const failed = [];
        if (failedImages) failed.push(`${failedImages} additional image${failedImages === 1 ? "" : "s"}`);
        if (failedFiles) failed.push(`${failedFiles} original file${failedFiles === 1 ? "" : "s"}`);
        lines.push(`⚠️ “${title}” was saved to “${clippingFolder}” with ${extractedEn}; ${failed.join(" and ")} failed to save.`);
      } else {
        lines.push(`🔖 “${title}” was saved to “${clippingFolder}” with ${extractedEn}.${savedFileDetail}`);
      }
    } else {
      if (clip.article?.extractionStatus === "partial") {
        const failedDetail = `${failedImages ? `，另有 ${failedImages} 张图片保存失败` : ""}${failedFiles ? `，${failedFiles} 个原文件保存失败` : ""}`;
        lines.push(`⚠️ 《${title}》正文提取不完整，已保存${partialZh}到「${clippingFolder}」${failedDetail}`);
      } else if (failedImages || failedFiles) {
        const failedDetail = `${failedImages ? `，另有 ${failedImages} 张图片保存失败` : ""}${failedFiles ? `，${failedFiles} 个原文件保存失败` : ""}`;
        lines.push(`⚠️ 《${title}》已提取${extractedZh}并保存到「${clippingFolder}」${failedDetail}`);
      } else {
        lines.push(`🔖 《${title}》已提取${extractedZh}并保存到「${clippingFolder}」${savedFileDetail}`);
      }
    }
  }

  for (const link of codeLinks) {
    const repository = displayTitle(link.repository || link.title || link.url, locale);
    const platform = displayTitle(link.name || link.hostname || translate(locale, "代码平台", "Code platform"), locale);
    lines.push(locale === "en"
      ? `🔗 Saved “${repository}” from ${platform} to “${codePlatformFolder}”.`
      : `🔗 已将 ${platform} 的「${repository}」分类保存到「${codePlatformFolder}」`);
  }

  if (locale === "en") {
    if (!clips.length && !codeLinks.length && !clipFailures && !codeLinkFailures) lines.push(`✍️ Saved to today's note in “${diaryFolder}”.`);
    if (savedAttachments) lines.push(`📎 Saved ${savedAttachments} attachment${savedAttachments === 1 ? "" : "s"} to today's note in “${diaryFolder}”.`);
    if (clipFailures) lines.push(`⚠️ ${clipFailures} web page${clipFailures === 1 ? "" : "s"} could not be extracted. The original link${clipFailures === 1 ? " was" : "s were"} kept in today's note in “${diaryFolder}”.`);
    if (codeLinkFailures) lines.push(`⚠️ ${codeLinkFailures} code-platform link${codeLinkFailures === 1 ? "" : "s"} could not be filed. The original link${codeLinkFailures === 1 ? " was" : "s were"} kept in today's note in “${diaryFolder}”.`);
    if (attachmentFailures) lines.push(`⚠️ ${attachmentFailures} attachment${attachmentFailures === 1 ? "" : "s"} failed to save. The original message was kept in today's note in “${diaryFolder}”.`);
    if (attachmentExtractionFailures) lines.push(`⚠️ Text could not be extracted from ${attachmentExtractionFailures} saved PDF attachment${attachmentExtractionFailures === 1 ? "" : "s"}. The original PDF${attachmentExtractionFailures === 1 ? " was" : "s were"} kept.`);
  } else {
    if (!clips.length && !codeLinks.length && !clipFailures && !codeLinkFailures) lines.push(`✍️ 已保存到今天的「${diaryFolder}」`);
    if (savedAttachments) lines.push(`📎 已保存 ${savedAttachments} 个附件到今天的「${diaryFolder}」`);
    if (clipFailures) lines.push(`⚠️ ${clipFailures} 个网页未能提取正文，原始链接已保存在今天的「${diaryFolder}」`);
    if (codeLinkFailures) lines.push(`⚠️ ${codeLinkFailures} 个代码平台地址未能分类保存，原始链接已保存在今天的「${diaryFolder}」`);
    if (attachmentFailures) lines.push(`⚠️ ${attachmentFailures} 个附件保存失败，原消息已保存在今天的「${diaryFolder}」`);
    if (attachmentExtractionFailures) lines.push(`⚠️ ${attachmentExtractionFailures} 个 PDF 附件未能提取正文，原 PDF 已保存`);
  }
  return `${lines.join("\n")}\n\n${formatAgentGuide({ ...result, diaryFolder }, locale)}`;
}

async function sendReplyWithRetry(reply, text, delays = [0, 700, 2_000]) {
  let lastError;
  for (const delay of delays) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      await reply(text);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("回执发送失败");
}

class CaptureRouter {
  constructor(diary, getStatus, options = {}) {
    this.diary = diary;
    this.getStatus = getStatus;
    this.replyRetryDelays = options.replyRetryDelays || [0, 700, 2_000];
    this.getLocale = options.getLocale || (() => "zh-CN");
    this.getStorage = options.getStorage || (() => ({}));
    this.getRemoteSearch = options.getRemoteSearch || (() => ({ enabled: false, exportFormat: "md" }));
    this.remoteSearch = options.remoteSearch || null;
  }

  async reply(envelope, text) {
    if (!envelope.reply) return;
    await sendReplyWithRetry(envelope.reply, text, this.replyRetryDelays);
  }

  async sendFile(envelope, file) {
    if (!file?.buffer) return { status: "unsupported" };
    if (typeof envelope.replyFile !== "function") return { status: "unsupported" };
    try {
      await envelope.replyFile(file);
      return { status: "sent" };
    } catch (error) {
      return { status: "failed", error: error?.message || String(error) };
    }
  }

  helpContext() {
    const storage = this.getStorage() || {};
    const remote = this.getRemoteSearch() || {};
    return {
      diaryFolder: storage.diaryFolder,
      remoteSearchEnabled: remote.enabled === true,
      remoteExportFormat: remote.exportFormat || "md",
    };
  }

  async handleRemoteCommand(envelope, command, locale) {
    if (this.getRemoteSearch()?.enabled !== true) {
      await this.reply(envelope, formatRemoteDisabledText(locale));
      return { command: `remote-${command.type}`, ignored: "remote-disabled" };
    }
    if (command.type === "help") {
      await this.reply(envelope, formatRemoteHelpText({ remoteSearch: this.getRemoteSearch() }, locale));
      return { command: "remote-help" };
    }
    if (!this.remoteSearch) {
      await this.reply(envelope, translate(locale, "远程查询服务尚未就绪。", "Remote search is not ready."));
      return { command: `remote-${command.type}`, error: "unavailable" };
    }
    const owner = { channel: envelope.channel, senderId: envelope.senderId };
    if (command.type === "cancel") {
      this.remoteSearch.clearOwner(owner.channel, owner.senderId);
      await this.remoteSearch.persist();
      await this.reply(envelope, formatRemoteCancelText(locale));
      return { command: "remote-cancel" };
    }
    if (command.type === "search") {
      try {
        await this.reply(envelope, formatRemoteAckText("search", locale));
        const result = await this.remoteSearch.search(command.keyword, owner);
        await this.reply(envelope, locale === "en" ? result.replyEn : result.replyZh);
        return { command: "remote-search", session: result.session };
      } catch (error) {
        await this.reply(envelope, translate(locale, "查询失败：{error}", "Search failed: {error}", { error: error?.message || error }));
        return { command: "remote-search", error: error?.message || String(error) };
      }
    }
    if (command.type === "export") {
      if (!command.indexes) {
        await this.reply(envelope, translate(locale, "请回复编号，例如：确认 1,3", "Reply with numbers, for example: confirm 1,3"));
        return { command: "remote-export", error: "missing-indexes" };
      }
      try {
        await this.reply(envelope, formatRemoteAckText("export", locale));
        const file = await this.remoteSearch.createExport(command.queryId, command.indexes, owner);
        const delivery = await this.sendFile(envelope, file);
        const channelName = getChannelMeta(envelope.channel, locale).name || envelope.channel || translate(locale, "该渠道", "this channel");
        await this.reply(envelope, formatRemoteExportReceipt(file, channelName, locale, delivery.status, delivery.error));
        return { command: "remote-export", file, delivery };
      } catch (error) {
        await this.reply(envelope, translate(locale, "导出失败：{error}", "Export failed: {error}", { error: error?.message || error }));
        return { command: "remote-export", error: error?.message || String(error) };
      }
    }
    return { command: "remote-unknown" };
  }

  async handle(envelope) {
    const text = stripRemoteCommandNoise(envelope.text);
    const appLocale = this.getLocale();
    if (text === "/help" || text.toLowerCase() === "help" || text === "帮助" || text === "幫助") {
      const locale = text.toLowerCase() === "help" ? "en" : (text === "幫助" || text === "帮助" ? "zh-CN" : appLocale);
      await this.reply(envelope, formatHelpText(locale, this.helpContext()));
      return { command: "help" };
    }
    const remoteCommand = parseRemoteCommand(text);
    if (remoteCommand) return this.handleRemoteCommand(envelope, remoteCommand, remoteCommand.locale || appLocale);
    const locale = appLocale;
    if (text === "/status") {
      const status = this.getStatus();
      const connected = Object.values(status).filter((item) => item.state === "connected").length;
      await this.reply(envelope, locale === "en"
        ? `Omnichannel Diary: ${connected} ${connected === 1 ? "channel" : "channels"} online. Data is written only to the current Vault.`
        : `Omnichannel Diary：${connected} 个渠道在线，数据只写入当前 Vault。`);
      return { command: "status" };
    }
    if (text.startsWith("/clip")) {
      const url = extractUrls(text)[0];
      if (!url) {
        await this.reply(envelope, translate(locale, "请使用 /clip https://example.com", "Use /clip https://example.com"));
        return { command: "clip", error: "missing-url" };
      }
      envelope.text = url;
    }
    const result = await this.diary.capture(envelope);
    if (result.ignored === "duplicate" && result.pendingReceipt && envelope.reply) {
      await this.reply(envelope, result.pendingReceipt);
      await this.diary.completeReceipt?.(result.messageKey);
      return result;
    }
    if (envelope.reply && !result.ignored) {
      const receipt = formatCaptureReceipt(result, locale);
      await this.diary.queueReceipt?.(result.messageKey, receipt);
      await this.reply(envelope, receipt);
      await this.diary.completeReceipt?.(result.messageKey);
    }
    return result;
  }
}

module.exports = { CaptureRouter, HELP_TEXT, formatAgentGuide, formatCaptureReceipt, formatHelpText, sendReplyWithRetry };
