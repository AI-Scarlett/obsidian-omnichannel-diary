"use strict";

const { WSClient } = require("@wecom/aibot-node-sdk");
const { BaseChannel } = require("./base");

class WeComChannel extends BaseChannel {
  constructor(config, context) {
    super("wecom", config, context);
    this.client = null;
  }

  attachment(kind, data, messageId) {
    if (!data?.url) return null;
    const extension = kind === "image" ? "jpg" : kind === "video" ? "mp4" : "bin";
    const mimeType = kind === "image" ? "image/jpeg" : kind === "video" ? "video/mp4" : "application/octet-stream";
    return {
      fileName: data.filename || `wecom-${kind}-${messageId}.${extension}`,
      mimeType,
      load: async () => {
        const downloaded = await this.client.downloadFile(data.url, data.aeskey);
        return { buffer: downloaded.buffer, fileName: downloaded.filename || `wecom-${kind}-${messageId}.${extension}`, mimeType };
      },
    };
  }

  normalize(frame) {
    const message = frame.body || {};
    const attachments = [];
    let text = message.text?.content || message.voice?.content || "";
    if (message.msgtype === "mixed") {
      const parts = message.mixed?.msg_item || [];
      text = parts.filter((item) => item.msgtype === "text").map((item) => item.text?.content || "").join("\n");
      for (const item of parts) {
        if (item.msgtype === "image") {
          const attachment = this.attachment("image", item.image, message.msgid);
          if (attachment) attachments.push(attachment);
        }
      }
    } else {
      const attachment = this.attachment(message.msgtype, message[message.msgtype], message.msgid);
      if (attachment) attachments.push(attachment);
    }
    return {
      id: message.msgid,
      timestamp: new Date(Number(message.create_time || 0) * 1000 || Date.now()),
      senderId: message.from?.userid || "wecom-user",
      senderName: message.from?.userid || "企业微信用户",
      chatName: message.chatid || "企业微信私聊",
      isGroup: message.chattype === "group",
      text,
      attachments,
      reply: async (replyText) => this.client.replyStream(frame, `diary-${message.msgid}`, replyText, true),
    };
  }

  async start() {
    this.assertFields(["botId", "secret"]);
    this.running = true;
    const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };
    this.client = new WSClient({ botId: this.config.botId, secret: this.config.secret, maxReconnectAttempts: -1, logger: quietLogger });
    this.client.on("authenticated", () => this.setState("connected", "企业微信长连接在线"));
    this.client.on("reconnecting", (attempt) => this.setState("connecting", `第 ${attempt} 次重连`));
    this.client.on("error", (error) => this.setState("error", error?.message || String(error)));
    this.client.on("message", (frame) => void this.deliver(this.normalize(frame)));
    this.setState("connecting", "正在连接企业微信");
    this.client.connect();
  }

  async stop() {
    this.running = false;
    this.client?.disconnect();
    this.client = null;
    this.setState("stopped");
  }
}

module.exports = { WeComChannel };
