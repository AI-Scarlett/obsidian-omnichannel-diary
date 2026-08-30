"use strict";

const { extractUrls } = require("./util");

const HELP_TEXT = [
  "Omnichannel Diary 已连接。",
  "• 直接发送文字、图片或文件：写入当天日记",
  "• 直接发送网页链接：保存正文与可下载图片",
  "• /clip <链接>：强制剪藏指定网页",
  "• /status：查看本地收集状态",
].join("\n");

function formatCaptureReceipt(result) {
  const clips = result.clips || [];
  const partialClips = clips.filter((clip) => clip.article?.extractionStatus === "partial").length;
  const imageFailures = clips.reduce((total, clip) => total + (clip.imageFailures?.length || 0), 0);
  const clipFailures = result.clipFailures?.length || 0;
  const attachmentFailures = result.attachmentFailures?.length || 0;
  const hasWarning = partialClips > 0 || imageFailures > 0 || clipFailures > 0 || attachmentFailures > 0;
  const lines = [hasWarning ? "⚠️ 已部分保存" : "✅ 已保存", `日记：${result.diaryPath}`];
  if (clips.length) {
    const detail = partialClips ? `，其中 ${partialClips} 篇正文不完整` : "，正文已提取";
    lines.push(`网页剪藏：${clips.length} 篇${detail}`);
  }
  if (clipFailures) lines.push(`网页失败：${clipFailures} 个（原始链接已保留）`);
  if (imageFailures) lines.push(`图片失败：${imageFailures} 张（远程地址已保留）`);
  if (attachmentFailures) lines.push(`附件失败：${attachmentFailures} 个`);
  return lines.join("\n");
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

module.exports = { CaptureRouter, HELP_TEXT, formatCaptureReceipt, sendReplyWithRetry };
