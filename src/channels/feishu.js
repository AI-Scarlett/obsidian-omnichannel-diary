"use strict";

const { BaseChannel } = require("./base");
const { readLimitedBody, safeFetch } = require("../core/network");
const { encodeMultipart, exportMimeType } = require("../core/util");

let larkRuntime;
function loadLarkRuntime() {
  if (!larkRuntime) larkRuntime = require("./feishu-sdk.mjs");
  return larkRuntime;
}

const FEISHU_API_DOMAINS = Object.freeze({
  feishu: "https://open.feishu.cn",
  lark: "https://open.larksuite.com",
});

function apiDomainForRegion(region) {
  return region === "lark" ? FEISHU_API_DOMAINS.lark : FEISHU_API_DOMAINS.feishu;
}

function streamResponse(response, fileName, mimeType) {
  const headerType = response.headers?.["content-type"] || response.headers?.get?.("content-type");
  return { buffer: Buffer.from(response.data), fileName, mimeType: headerType || mimeType || "application/octet-stream" };
}

class FeishuApiClient {
  constructor(config, domain, http, options = {}) {
    this.config = config;
    this.domain = String(domain).replace(/\/$/, "");
    this.http = http || loadLarkRuntime().defaultHttpInstance;
    this.fetch = options.fetch || safeFetch;
    this.token = "";
    this.tokenExpiresAt = 0;
  }

  async accessToken() {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    const response = await this.http.post(`${this.domain}/open-apis/auth/v3/tenant_access_token/internal`, {
      app_id: this.config.appId,
      app_secret: this.config.appSecret,
    });
    if (!response?.tenant_access_token || (response.code !== undefined && response.code !== 0)) {
      throw new Error(response?.msg || "Feishu tenant access token request failed");
    }
    this.token = response.tenant_access_token;
    this.tokenExpiresAt = Date.now() + Math.max(60, Number(response.expire || 7200) - 120) * 1_000;
    return this.token;
  }

  async headers() {
    return { Authorization: `Bearer ${await this.accessToken()}` };
  }

  async resource(messageId, fileKey, type) {
    return this.http.get(`${this.domain}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}`, {
      $return_headers: true,
      headers: await this.headers(),
      params: { type },
      responseType: "arraybuffer",
    });
  }

  async reply(chatId, text) {
    const response = await this.http.post(`${this.domain}/open-apis/im/v1/messages`, {
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text }),
    }, {
      headers: await this.headers(),
      params: { receive_id_type: "chat_id" },
    });
    if (response?.code !== undefined && response.code !== 0) throw new Error(response.msg || "Feishu reply failed");
    return response;
  }

  async uploadFile(file) {
    const fileName = String(file?.name || "export.bin");
    const buffer = Buffer.isBuffer(file?.buffer) ? file.buffer : Buffer.from(file?.buffer || []);
    if (!buffer.length) throw new Error("导出文件为空");
    const multipart = encodeMultipart(
      { file_type: "stream", file_name: fileName },
      [{ field: "file", fileName, mimeType: file?.mimeType || exportMimeType(file?.format, fileName), buffer }],
    );
    const { response } = await this.fetch(`${this.domain}/open-apis/im/v1/files`, {
      method: "POST",
      headers: { ...(await this.headers()), "content-type": multipart.contentType },
      body: multipart.body,
      accept: "application/json",
      timeoutMs: 60_000,
    });
    const text = (await readLimitedBody(response, 2 * 1024 * 1024)).toString("utf8");
    let parsed = {};
    try { parsed = JSON.parse(text || "{}"); } catch (_) { parsed = {}; }
    const fileKey = parsed?.data?.file_key || parsed?.file_key;
    if (!response.ok || (parsed?.code !== undefined && parsed.code !== 0) || !fileKey) {
      throw new Error(parsed?.msg || parsed?.message || `Feishu file upload failed HTTP ${response.status}`);
    }
    return fileKey;
  }

  async replyFile(chatId, file) {
    const fileKey = await this.uploadFile(file);
    const response = await this.http.post(`${this.domain}/open-apis/im/v1/messages`, {
      receive_id: chatId,
      msg_type: "file",
      content: JSON.stringify({ file_key: fileKey }),
    }, {
      headers: await this.headers(),
      params: { receive_id_type: "chat_id" },
    });
    if (response?.code !== undefined && response.code !== 0) throw new Error(response.msg || "Feishu file reply failed");
    return response;
  }
}

class FeishuChannel extends BaseChannel {
  constructor(config, context) {
    super("feishu", config, context);
    this.client = null;
    this.wsClient = null;
    this.registrationAbort = null;
  }

  get clientDomain() {
    const Lark = loadLarkRuntime();
    return this.config.domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu;
  }

  get apiDomain() {
    return apiDomainForRegion(this.config.domain);
  }

  get registrationDomain() {
    return this.config.domain === "lark" ? "accounts.larksuite.com" : "accounts.feishu.cn";
  }

  async beginRegistration(callbacks = {}) {
    const Lark = loadLarkRuntime();
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
        const response = await this.client.resource(messageId, fileKey, type);
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
    let text = "";
    if (typeof content.text === "string") text = content.text;
    else if (typeof content.content === "string") text = content.content;
    else if (message.message_type === "post") text = JSON.stringify(content);
    else if (content && typeof content === "object") text = JSON.stringify(content);
    return {
      id: message.message_id,
      timestamp: new Date(Number(message.create_time || 0) || Date.now()),
      senderId,
      senderName: senderId,
      chatName: message.chat_id || this.t("飞书私聊", "Feishu direct message"),
      isGroup: message.chat_type === "group",
      text,
      attachments,
      reply: async (replyText) => this.client.reply(message.chat_id, replyText),
      replyFile: async (file) => this.client.replyFile(message.chat_id, file),
    };
  }

  async start() {
    const Lark = loadLarkRuntime();
    this.assertFields(["appId", "appSecret"]);
    this.running = true;
    if (Lark.defaultHttpInstance?.defaults) Lark.defaultHttpInstance.defaults.adapter = "http";
    const baseConfig = { appId: this.config.appId, appSecret: this.config.appSecret, domain: this.clientDomain };
    this.client = new FeishuApiClient(this.config, this.apiDomain);
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

module.exports = { FeishuApiClient, FeishuChannel, apiDomainForRegion, streamResponse };
