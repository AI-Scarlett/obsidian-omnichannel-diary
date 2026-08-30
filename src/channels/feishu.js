"use strict";

const Lark = require("@larksuiteoapi/node-sdk");
const { BaseChannel } = require("./base");

async function streamResponse(response, fileName, mimeType) {
  const chunks = [];
  for await (const chunk of response.getReadableStream()) chunks.push(Buffer.from(chunk));
  const headerType = response.headers?.["content-type"] || response.headers?.get?.("content-type");
  return { buffer: Buffer.concat(chunks), fileName, mimeType: headerType || mimeType || "application/octet-stream" };
}

class FeishuChannel extends BaseChannel {
  constructor(config, context) {
    super("feishu", config, context);
    this.client = null;
    this.wsClient = null;
    this.registrationAbort = null;
  }

  get clientDomain() {
    return this.config.domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu;
  }

  get registrationDomain() {
    return this.config.domain === "lark" ? "accounts.larksuite.com" : "accounts.feishu.cn";
  }

  async beginRegistration(callbacks = {}) {
    callbacks.onStatus?.(this.t("等待飞书 / Lark 官方授权…", "Waiting for official Feishu / Lark authorization…"));
    if (Lark.defaultHttpInstance?.defaults) Lark.defaultHttpInstance.defaults.adapter = "http";
    const controller = new AbortController();
    this.registrationAbort = controller;
    let result;
    try {
      result = await Lark.registerApp({
        domain: this.registrationDomain,
        larkDomain: "accounts.larksuite.com",
        signal: controller.signal,
        onQRCodeReady: (info) => {
          callbacks.onQr?.(info.url);
          callbacks.onStatus?.(this.t("请扫码并按页面提示授权创建应用", "Scan the QR code and follow the page to authorize app creation"));
        },
        onStatusChange: (info) => callbacks.onStatus?.(this.t("授权状态：{status}", "Authorization status: {status}", { status: info.status || info })),
      });
    } finally {
      if (this.registrationAbort === controller) this.registrationAbort = null;
    }
    this.config.appId = result.client_id;
    this.config.appSecret = result.client_secret;
    this.config.enabled = true;
    await this.context.saveSettings();
    callbacks.onStatus?.(this.t("飞书应用已创建并保存", "Feishu / Lark app created and saved"));
    return this.config;
  }

  resourceAttachment(messageId, fileKey, type, fileName, mimeType) {
    return {
      fileName,
      mimeType,
      load: async () => {
        const response = await this.client.im.messageResource.get({ params: { type }, path: { message_id: messageId, file_key: fileKey } });
        return streamResponse(response, fileName, mimeType);
      },
    };
  }

  normalize(event) {
    const message = event.message || {};
    const sender = event.sender || {};
    let content = {};
    try { content = JSON.parse(message.content || "{}"); } catch (_) { content = { text: message.content || "" }; }
    const attachments = [];
    if (message.message_type === "image" && content.image_key) {
      attachments.push(this.resourceAttachment(message.message_id, content.image_key, "image", `feishu-${message.message_id}.jpg`, "image/jpeg"));
    }
    if (["file", "audio", "media"].includes(message.message_type) && content.file_key) {
      const mime = message.message_type === "audio" ? "audio/ogg" : message.message_type === "media" ? "video/mp4" : "application/octet-stream";
      attachments.push(this.resourceAttachment(message.message_id, content.file_key, message.message_type, content.file_name || `feishu-${message.message_type}-${message.message_id}`, mime));
    }
    if (message.message_type === "media" && content.image_key) {
      attachments.push(this.resourceAttachment(message.message_id, content.image_key, "image", `feishu-cover-${message.message_id}.jpg`, "image/jpeg"));
    }
    const senderId = sender.sender_id?.open_id || sender.sender_id?.user_id || "feishu-user";
    const text = content.text || content.content || (message.message_type === "post" ? JSON.stringify(content) : "");
    return {
      id: message.message_id,
      timestamp: new Date(Number(message.create_time || 0) || Date.now()),
      senderId,
      senderName: senderId,
      chatName: message.chat_id || this.t("飞书私聊", "Feishu direct message"),
      isGroup: message.chat_type === "group",
      text,
      attachments,
      reply: async (replyText) => this.client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: { receive_id: message.chat_id, msg_type: "text", content: JSON.stringify({ text: replyText }) },
      }),
    };
  }

  async start() {
    this.assertFields(["appId", "appSecret"]);
    this.running = true;
    if (Lark.defaultHttpInstance?.defaults) Lark.defaultHttpInstance.defaults.adapter = "http";
    const baseConfig = { appId: this.config.appId, appSecret: this.config.appSecret, domain: this.clientDomain };
    this.client = new Lark.Client(baseConfig);
    this.wsClient = new Lark.WSClient({
      ...baseConfig,
      loggerLevel: Lark.LoggerLevel.error,
      onReady: () => this.setState("connected", this.config.domain === "lark" ? this.t("Lark 长连接在线", "Lark persistent connection online") : this.t("飞书长连接在线", "Feishu persistent connection online")),
      onError: (error) => this.setState("error", error?.message || String(error)),
      onReconnecting: () => this.setState("connecting", this.t("正在重新连接", "Reconnecting")),
    });
    const dispatcher = new Lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data) => this.deliver(this.normalize(data)),
    });
    this.setState("connecting", this.t("正在建立飞书长连接", "Starting Feishu / Lark persistent connection"));
    await this.wsClient.start({ eventDispatcher: dispatcher });
  }

  async stop() {
    this.running = false;
    this.registrationAbort?.abort();
    this.registrationAbort = null;
    this.wsClient?.close({ force: true });
    this.wsClient = null;
    this.client = null;
    this.setState("stopped");
  }
}

module.exports = { FeishuChannel, streamResponse };
