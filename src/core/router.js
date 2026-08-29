"use strict";

const { extractUrls } = require("./util");

const HELP_TEXT = [
  "Omnichannel Diary 已连接。",
  "• 直接发送文字、图片或文件：写入当天日记",
  "• 直接发送网页链接：保存正文与可下载图片",
  "• /clip <链接>：强制剪藏指定网页",
  "• /status：查看本地收集状态",
].join("\n");

class CaptureRouter {
  constructor(diary, getStatus) {
    this.diary = diary;
    this.getStatus = getStatus;
  }

  async handle(envelope) {
    const text = String(envelope.text || "").trim();
    if (text === "/help" || text === "帮助") {
      if (envelope.reply) await envelope.reply(HELP_TEXT);
      return { command: "help" };
    }
    if (text === "/status") {
      const status = this.getStatus();
      const connected = Object.values(status).filter((item) => item.state === "connected").length;
      if (envelope.reply) await envelope.reply(`Omnichannel Diary：${connected} 个渠道在线，数据只写入当前 Vault。`);
      return { command: "status" };
    }
    if (text.startsWith("/clip")) {
      const url = extractUrls(text)[0];
      if (!url) {
        if (envelope.reply) await envelope.reply("请使用 /clip https://example.com");
        return { command: "clip", error: "missing-url" };
      }
      envelope.text = url;
    }
    const result = await this.diary.capture(envelope);
    if (envelope.reply && !result.ignored) {
      const suffix = result.clips?.length ? `，并生成 ${result.clips.length} 篇网页剪藏` : "";
      await envelope.reply(`已保存到 ${result.diaryPath}${suffix}。`);
    }
    return result;
  }
}

module.exports = { CaptureRouter, HELP_TEXT };
