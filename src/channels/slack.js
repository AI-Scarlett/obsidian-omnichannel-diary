"use strict";

const WebSocket = require("ws");
const { BaseChannel } = require("./base");
const { readLimitedBody, safeFetch } = require("../core/network");

class SlackChannel extends BaseChannel {
  constructor(config, context) {
    super("slack", config, context);
    this.socket = null;
    this.reconnectTimer = null;
  }

  async webApi(method, data, token = this.config.botToken) {
    const { response } = await safeFetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(data || {}), accept: "application/json", timeoutMs: 20_000,
    });
    const result = JSON.parse((await readLimitedBody(response, 2 * 1024 * 1024)).toString("utf8"));
    if (!response.ok || !result.ok) throw new Error(result.error || `Slack HTTP ${response.status}`);
    return result;
  }

  async connect() {
    const opened = await this.webApi("apps.connections.open", {}, this.config.appToken);
    if (!this.running) return;
    this.socket = new WebSocket(opened.url);
    this.socket.on("open", () => this.setState("connected", this.t("Socket Mode 在线", "Socket Mode online")));
    this.socket.on("message", (data) => void this.onSocketMessage(data));
    this.socket.on("error", (error) => this.setState("error", error.message));
    this.socket.on("close", () => {
      this.socket = null;
      if (this.running) {
        this.setState("connecting", this.t("正在重新连接", "Reconnecting"));
        this.reconnectTimer = setTimeout(() => void this.connect().catch((error) => this.setState("error", error.message)), 3_000);
      }
    });
  }

  async onSocketMessage(raw) {
    let packet;
    try { packet = JSON.parse(String(raw)); } catch (_) { return; }
    if (packet.envelope_id && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ envelope_id: packet.envelope_id }));
    }
    if (packet.type !== "events_api") return;
    const event = packet.payload?.event;
    if (!event || event.type !== "message" || event.bot_id || event.subtype) return;
    const files = (event.files || []).filter((file) => file.url_private_download).map((file) => ({
      fileName: file.name || `slack-${file.id}`,
      mimeType: file.mimetype || "application/octet-stream",
      url: file.url_private_download,
      headers: { authorization: `Bearer ${this.config.botToken}` },
    }));
    await this.deliver({
      id: event.client_msg_id || event.ts,
      timestamp: new Date(Number(event.ts) * 1000),
      senderId: event.user || "slack-user",
      senderName: event.user_profile?.display_name || event.user_profile?.real_name || event.user || this.t("Slack 用户", "Slack user"),
      chatName: event.channel || this.t("Slack 会话", "Slack conversation"),
      isGroup: event.channel_type !== "im",
      text: event.text || "",
      attachments: files,
      reply: async (text) => this.webApi("chat.postMessage", { channel: event.channel, thread_ts: event.ts, text }),
    });
  }

  async start() {
    this.assertFields(["appToken", "botToken"]);
    this.running = true;
    this.setState("connecting", this.t("正在连接 Socket Mode", "Connecting to Socket Mode"));
    await this.connect();
  }

  async stop() {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
    this.setState("stopped");
  }
}

module.exports = { SlackChannel };
