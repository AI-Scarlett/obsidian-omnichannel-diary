"use strict";

const { DWClient, TOPIC_ROBOT } = require("dingtalk-stream");
const { BaseChannel } = require("./base");
const { safeFetch } = require("../core/network");

class DingTalkChannel extends BaseChannel {
  constructor(config, context) {
    super("dingtalk", config, context);
    this.client = null;
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
