"use strict";

const { translate } = require("./i18n");
const { extractUrls } = require("./util");

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
  const diaryFallback = translate(locale, "日记", "Daily");
  const diaryFolder = displayFolder(result.diaryFolder || folderFromPath(result.diaryPath, diaryFallback), diaryFallback);
  return locale === "en" ? [
    "Hi! I'm your quick-capture Agent ✍️",
    `Send me any text, voice note, image, or file and I'll add it to today's note. Send a web link and I'll extract supported articles, cloud documents, PDFs, technical-community posts, answers, and comment threads into a Markdown clipping with an entry in today's note. Your notes are stored in the “${diaryFolder}” folder. To change it, open Obsidian Settings → Community plugins → Omnichannel Diary → Storage & privacy → Daily notes. If something needs correcting, edit it directly in Obsidian. Send “help” anytime to see all commands.`,
  ].join("\n") : [
    "嗨~ 我是你的随手记 Agent ✍️",
    `想记什么直接发给我，文字、语音、图片、文件都行，我会记到你今天的笔记里。发网页链接，我会提取支持的文章、云文档、PDF，以及国内外技术社区的帖子、问答和评论串，存成 Markdown 剪藏，并在今天的笔记里留入口。记的东西在 Obsidian 的「${diaryFolder}」文件夹；想换地方：Obsidian 设置 → 第三方插件 → Omnichannel Diary → 存储与隐私 → 每日笔记。说错了可以直接在 Obsidian 里修改，随时发「帮助」看全部用法。`,
  ].join("\n");
}

function formatHelpText(locale = "zh-CN", result = {}) {
  const commands = locale === "en" ? [
    "Available commands:",
    "• Send text, a voice note, an image, or a file: add it to today's note",
    "• Send a web link: extract articles, cloud documents, PDFs, images, technical-community posts, answers, and supported comment threads into a Markdown clipping",
    "• /clip <URL>: clip only the specified page",
    "• /status: show the current channel connection status",
  ] : [
    "可用指令：",
    "• 直接发送文字、语音、图片或文件：写入今天的笔记",
    "• 直接发送网页链接：提取文章、云文档、PDF、图片，以及技术社区帖子、问答和支持的评论串，生成 Markdown 剪藏",
    "• /clip <链接>：只剪藏指定网页",
    "• /status：查看当前渠道连接状态",
  ];
  return [formatAgentGuide(result, locale), "", ...commands].join("\n");
}

const HELP_TEXT = formatHelpText("zh-CN");

function formatCaptureReceipt(result, locale = "zh-CN") {
  const clips = result.clips || [];
  const clipFailures = result.clipFailures?.length || 0;
  const attachmentFailures = result.attachmentFailures?.length || 0;
  const savedAttachments = Number(result.savedAttachments) || 0;
  const diaryFallback = translate(locale, "日记", "Daily");
  const clippingFallback = translate(locale, "全渠道剪藏", "Clippings");
  const diaryFolder = displayFolder(result.diaryFolder || folderFromPath(result.diaryPath, diaryFallback), diaryFallback);
  const clippingFolder = displayFolder(result.clippingFolder || folderFromPath(clips[0]?.notePath, clippingFallback), clippingFallback);
  const lines = [];

  for (const clip of clips) {
    const title = displayTitle(clip.article?.title, locale);
    const savedImages = Math.max(0, Number(clip.savedImages) || 0);
    const failedImages = clip.imageFailures?.length || 0;
    const savedFiles = Math.max(0, Number(clip.savedFiles) || 0);
    const failedFiles = clip.fileFailures?.length || 0;
    const commentCount = Math.max(0, Number(clip.article?.commentCount) || 0);
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

  if (locale === "en") {
    if (!clips.length && !clipFailures) lines.push(`✍️ Saved to today's note in “${diaryFolder}”.`);
    if (savedAttachments) lines.push(`📎 Saved ${savedAttachments} attachment${savedAttachments === 1 ? "" : "s"} to today's note in “${diaryFolder}”.`);
    if (clipFailures) lines.push(`⚠️ ${clipFailures} web page${clipFailures === 1 ? "" : "s"} could not be extracted. The original link${clipFailures === 1 ? " was" : "s were"} kept in today's note in “${diaryFolder}”.`);
    if (attachmentFailures) lines.push(`⚠️ ${attachmentFailures} attachment${attachmentFailures === 1 ? "" : "s"} failed to save. The original message was kept in today's note in “${diaryFolder}”.`);
  } else {
    if (!clips.length && !clipFailures) lines.push(`✍️ 已保存到今天的「${diaryFolder}」`);
    if (savedAttachments) lines.push(`📎 已保存 ${savedAttachments} 个附件到今天的「${diaryFolder}」`);
    if (clipFailures) lines.push(`⚠️ ${clipFailures} 个网页未能提取正文，原始链接已保存在今天的「${diaryFolder}」`);
    if (attachmentFailures) lines.push(`⚠️ ${attachmentFailures} 个附件保存失败，原消息已保存在今天的「${diaryFolder}」`);
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
  }

  async reply(envelope, text) {
    if (!envelope.reply) return;
    await sendReplyWithRetry(envelope.reply, text, this.replyRetryDelays);
  }

  async handle(envelope) {
    const text = String(envelope.text || "").trim();
    const locale = this.getLocale();
    if (text === "/help" || text.toLowerCase() === "help" || text === "帮助") {
      const storage = this.getStorage() || {};
      await this.reply(envelope, formatHelpText(locale, { diaryFolder: storage.diaryFolder }));
      return { command: "help" };
    }
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
