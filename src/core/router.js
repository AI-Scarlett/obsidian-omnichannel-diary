"use strict";

const { extractUrls } = require("./util");

function displayFolder(value, fallback) {
  return String(value || fallback).replace(/^\/+|\/+$/g, "").trim() || fallback;
}

function folderFromPath(filePath, fallback) {
  const parts = String(filePath || "").replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join("/") : fallback;
}

function displayTitle(value) {
  const title = String(value || "未命名网页").replace(/\s+/g, " ").trim() || "未命名网页";
  return title.length > 100 ? `${title.slice(0, 99)}…` : title;
}

function formatAgentGuide(result = {}) {
  const diaryFolder = displayFolder(result.diaryFolder || folderFromPath(result.diaryPath, "日记"), "日记");
  return [
    "嗨~ 我是你的随手记 Agent ✍️",
    `想记什么直接发给我，文字、语音、图片、文件都行，我会记到你今天的笔记里。发网页链接，我会提取正文存成一篇 Markdown 剪藏，并在今天的笔记里留入口。记的东西在 Obsidian 的「${diaryFolder}」文件夹；想换地方：Obsidian 设置 → 第三方插件 → Omnichannel Diary → 存储与隐私 → 每日笔记。说错了可以直接在 Obsidian 里修改，随时发「帮助」看全部用法。`,
  ].join("\n");
}

const HELP_TEXT = [
  formatAgentGuide(),
  "",
  "可用指令：",
  "• 直接发送文字、语音、图片或文件：写入今天的笔记",
  "• 直接发送网页链接：提取正文与图片，生成 Markdown 剪藏",
  "• /clip <链接>：只剪藏指定网页",
  "• /status：查看当前渠道连接状态",
].join("\n");

function formatCaptureReceipt(result) {
  const clips = result.clips || [];
  const clipFailures = result.clipFailures?.length || 0;
  const attachmentFailures = result.attachmentFailures?.length || 0;
  const savedAttachments = Number(result.savedAttachments) || 0;
  const diaryFolder = displayFolder(result.diaryFolder || folderFromPath(result.diaryPath, "日记"), "日记");
  const clippingFolder = displayFolder(result.clippingFolder || folderFromPath(clips[0]?.notePath, "全渠道剪藏"), "全渠道剪藏");
  const lines = [];

  for (const clip of clips) {
    const title = displayTitle(clip.article?.title);
    const savedImages = Math.max(0, Number(clip.savedImages) || 0);
    const failedImages = clip.imageFailures?.length || 0;
    if (clip.article?.extractionStatus === "partial") {
      const failedDetail = failedImages ? `，另有 ${failedImages} 张图片保存失败` : "";
      lines.push(`⚠️ 《${title}》正文提取不完整，已保存正文片段和 ${savedImages} 张图片到「${clippingFolder}」${failedDetail}`);
    } else if (failedImages) {
      lines.push(`⚠️ 《${title}》已提取正文和 ${savedImages} 张图片并保存到「${clippingFolder}」，另有 ${failedImages} 张图片保存失败`);
    } else {
      lines.push(`🔖 《${title}》已提取正文和 ${savedImages} 张图片并保存到「${clippingFolder}」`);
    }
  }

  if (!clips.length && !clipFailures) lines.push(`✍️ 已保存到今天的「${diaryFolder}」`);
  if (savedAttachments) lines.push(`📎 已保存 ${savedAttachments} 个附件到今天的「${diaryFolder}」`);
  if (clipFailures) lines.push(`⚠️ ${clipFailures} 个网页未能提取正文，原始链接已保存在今天的「${diaryFolder}」`);
  if (attachmentFailures) lines.push(`⚠️ ${attachmentFailures} 个附件保存失败，原消息已保存在今天的「${diaryFolder}」`);
  return `${lines.join("\n")}\n\n${formatAgentGuide({ ...result, diaryFolder })}`;
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
  }

  async reply(envelope, text) {
    if (!envelope.reply) return;
    await sendReplyWithRetry(envelope.reply, text, this.replyRetryDelays);
  }

  async handle(envelope) {
    const text = String(envelope.text || "").trim();
    if (text === "/help" || text === "帮助") {
      await this.reply(envelope, HELP_TEXT);
      return { command: "help" };
    }
    if (text === "/status") {
      const status = this.getStatus();
      const connected = Object.values(status).filter((item) => item.state === "connected").length;
      await this.reply(envelope, `Omnichannel Diary：${connected} 个渠道在线，数据只写入当前 Vault。`);
      return { command: "status" };
    }
    if (text.startsWith("/clip")) {
      const url = extractUrls(text)[0];
      if (!url) {
        await this.reply(envelope, "请使用 /clip https://example.com");
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
      const receipt = formatCaptureReceipt(result);
      await this.diary.queueReceipt?.(result.messageKey, receipt);
      await this.reply(envelope, receipt);
      await this.diary.completeReceipt?.(result.messageKey);
    }
    return result;
  }
}

module.exports = { CaptureRouter, HELP_TEXT, formatAgentGuide, formatCaptureReceipt, sendReplyWithRetry };
