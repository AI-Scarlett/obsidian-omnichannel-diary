"use strict";

const { DWClient, TOPIC_ROBOT } = require("dingtalk-stream");
const { BaseChannel } = require("./base");
const { encodeMultipart, exportMimeType } = require("../core/util");
const { readLimitedBody, safeFetch } = require("../core/network");

class DingTalkChannel extends BaseChannel {
  constructor(config, context) {
    super("dingtalk", config, context);
    this.client = null;
  }

  async accessToken() {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    const { response } = await safeFetch("https://api.dingtalk.com/v1.0/oauth2/accessToken", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appKey: this.config.clientId, appSecret: this.config.clientSecret }),
      accept: "application/json",
      timeoutMs: 20_000,
    });
    const result = JSON.parse((await readLimitedBody(response, 1024 * 1024)).toString("utf8"));
    if (!response.ok || !result.accessToken) throw new Error(result.message || `DingTalk token HTTP ${response.status}`);
    this.token = result.accessToken;
    this.tokenExpiresAt = Date.now() + Math.max(60, Number(result.expireIn || 7200) - 120) * 1_000;
    return this.token;
  }

  async sendFile(message, file) {
    const token = await this.accessToken();
    const multipart = encodeMultipart(
      {},
      [{ field: "media", fileName: file?.name || "export.bin", mimeType: file?.mimeType || exportMimeType(file?.format, file?.name), buffer: file?.buffer }],
    );
    const { response: uploadResponse } = await safeFetch(`https://oapi.dingtalk.com/media/upload?access_token=${encodeURIComponent(token)}&type=file`, {
      method: "POST",
      headers: { "content-type": multipart.contentType },
      body: multipart.body,
      accept: "application/json",
      timeoutMs: 60_000,
    });
    const uploaded = JSON.parse((await readLimitedBody(uploadResponse, 1024 * 1024)).toString("utf8"));
    const mediaId = uploaded.media_id || uploaded.mediaId;
    if (!uploadResponse.ok || uploaded.errcode || !mediaId) {
      throw new Error(uploaded.errmsg || uploaded.message || `DingTalk upload HTTP ${uploadResponse.status}`);
    }
    const robotCode = message.robotCode || this.config.clientId;
    const openConversationId = message.conversationId;
    const staffId = message.senderStaffId || message.senderId;
    if (String(message.conversationType) !== "2" && !staffId) {
      throw new Error("钉钉消息缺少发送者，无法发送文件");
    }
    let url = "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend";
    let body = {
      robotCode,
      userIds: staffId ? [staffId] : [],
      msgKey: "sampleFile",
      msgParam: JSON.stringify({ mediaId, fileName: file?.name || "export.bin", fileType: String(file?.name || "").split(".").pop() || "bin" }),
    };
    if (String(message.conversationType) === "2" && openConversationId) {
      url = "https://api.dingtalk.com/v1.0/robot/groupMessages/send";
      body = {
        robotCode,
        openConversationId,
        msgKey: "sampleFile",
        msgParam: JSON.stringify({ mediaId, fileName: file?.name || "export.bin", fileType: String(file?.name || "").split(".").pop() || "bin" }),
      };
    }
    const { response } = await safeFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-acs-dingtalk-access-token": token },
      body: JSON.stringify(body),
      accept: "application/json",
      timeoutMs: 30_000,
    });
    const result = JSON.parse((await readLimitedBody(response, 1024 * 1024)).toString("utf8"));
    if (!response.ok) throw new Error(result.message || `DingTalk send file HTTP ${response.status}`);
    return result;
  }

  async onMessage(frame) {
    let message;
    try { message = JSON.parse(frame.data || "{}"); } catch (_) { message = {}; }
    this.client?.socketCallBackResponse(frame.headers.messageId, { status: "SUCCESS", message: "received" });
    const attachments = [];
    const content = message.content || {};
    if (content.downloadUrl) attachments.push({ url: content.downloadUrl, fileName: content.fileName || `dingtalk-${message.msgId}`, mimeType: content.mimeType });
    await this.deliver({
      id: message.msgId || frame.headers.messageId,
      timestamp: new Date(Number(message.createAt || frame.headers.time) || Date.now()),
      senderId: message.senderStaffId || message.senderId || "dingtalk-user",
      senderName: message.senderNick || this.t("钉钉用户", "DingTalk user"),
      chatName: message.conversationId || this.t("钉钉私聊", "DingTalk direct message"),
      isGroup: String(message.conversationType) === "2",
      text: message.text?.content || content.text || message.content?.content || "",
      attachments,
      reply: message.sessionWebhook ? async (text) => {
        const { response } = await safeFetch(message.sessionWebhook, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ msgtype: "text", text: { content: text } }), accept: "application/json",
        });
        if (!response.ok) throw new Error(this.t("钉钉回复失败：HTTP {status}", "DingTalk reply failed: HTTP {status}", { status: response.status }));
      } : undefined,
      replyFile: async (file) => this.sendFile(message, file),
    });
  }

  async start() {
    this.assertFields(["clientId", "clientSecret"]);
    this.running = true;
    this.client = new DWClient({ clientId: this.config.clientId, clientSecret: this.config.clientSecret, keepAlive: true, debug: false });
    this.client.registerCallbackListener(TOPIC_ROBOT, (frame) => void this.onMessage(frame));
    this.client.on("error", (error) => this.setState("error", error?.message || String(error)));
    this.setState("connecting", this.t("正在建立 Stream 连接", "Starting Stream connection"));
    await this.client.connect();
    this.setState("connected", this.t("钉钉 Stream 在线", "DingTalk Stream online"));
  }

  async stop() {
    this.running = false;
    this.client?.disconnect();
    this.client = null;
    this.setState("stopped");
  }
}

module.exports = { DingTalkChannel };
