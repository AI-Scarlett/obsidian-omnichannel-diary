"use strict";

const { BaseChannel } = require("./base");

class QQChannel extends BaseChannel {
  constructor(config, context) {
    super("qq", config, context);
    this.bot = null;
  }

  async start() {
    this.assertFields(["appId", "appSecret"]);
    this.running = true;
    const { QQBot } = await import("@tencent-connect/qqbot-nodejs");
    const logger = { debug() {}, info() {}, warn() {}, error() {} };
    this.bot = new QQBot({ appId: this.config.appId, appSecret: this.config.appSecret, logger, tokenPrefetch: "sync" });
    this.bot.on("ready", () => this.setState("connected", this.t("QQ Gateway 在线", "QQ Gateway online")));
    this.bot.on("resumed", () => this.setState("connected", this.t("QQ Gateway 已恢复", "QQ Gateway resumed")));
    this.bot.on("error", (error) => this.setState("error", error?.message || String(error)));
    this.bot.on("message", async (_ctx, message) => {
      if (message.senderIsBot) return;
      await this.deliver({
        id: message.messageId,
        timestamp: new Date(message.timestamp),
        senderId: message.senderId,
        senderName: message.senderName || this.t("QQ 用户", "QQ user"),
        chatName: message.groupOpenid || message.channelId || this.t("QQ 私聊", "QQ direct message"),
        isGroup: ["group", "guild"].includes(message.kind),
        mentioned: Boolean(message.mentions?.length),
        text: message.content || "",
        attachments: (message.attachments || []).map((item) => ({
          fileName: item.filename || `qq-${message.messageId}`,
          mimeType: item.content_type || "application/octet-stream",
          url: item.voice_wav_url || item.url,
        })),
        reply: async (text) => this.bot.sendText(message.replyTarget, text),
        replyFile: async (file) => this.bot.sendFile(message.replyTarget, { buffer: file.buffer }, { fileName: file.name || "export.bin" }),
      });
    });
    this.setState("connecting", this.t("正在连接 QQ Gateway", "Connecting to QQ Gateway"));
    void this.bot.start().catch((error) => this.setState("error", error?.message || String(error)));
  }

  async stop() {
    this.running = false;
    this.bot?.stop();
    this.bot = null;
    this.setState("stopped");
  }
}

module.exports = { QQChannel };
