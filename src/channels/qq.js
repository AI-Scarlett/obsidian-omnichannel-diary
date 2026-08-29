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
    this.bot.on("ready", () => this.setState("connected", "QQ Gateway 在线"));
    this.bot.on("resumed", () => this.setState("connected", "QQ Gateway 已恢复"));
    this.bot.on("error", (error) => this.setState("error", error?.message || String(error)));
    this.bot.on("message", async (_ctx, message) => {
      if (message.senderIsBot) return;
      await this.deliver({
        id: message.messageId,
        timestamp: new Date(message.timestamp),
        senderId: message.senderId,
        senderName: message.senderName || "QQ 用户",
        chatName: message.groupOpenid || message.channelId || "QQ 私聊",
        isGroup: ["group", "guild"].includes(message.kind),
        mentioned: Boolean(message.mentions?.length),
        text: message.content || "",
        attachments: (message.attachments || []).map((item) => ({
          fileName: item.filename || `qq-${message.messageId}`,
          mimeType: item.content_type || "application/octet-stream",
          url: item.voice_wav_url || item.url,
        })),
        reply: async (text) => this.bot.sendText(message.replyTarget, text),
      });
    });
    this.setState("connecting", "正在连接 QQ Gateway");
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
