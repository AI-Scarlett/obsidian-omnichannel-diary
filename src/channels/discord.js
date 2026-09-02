"use strict";

const WebSocket = require("ws");
const { BaseChannel } = require("./base");
const { readLimitedBody, safeFetch } = require("../core/network");
const { encodeMultipart, exportMimeType } = require("../core/util");

class DiscordChannel extends BaseChannel {
  constructor(config, context) {
    super("discord", config, context);
    this.socket = null;
    this.heartbeat = null;
    this.sequence = null;
    this.botId = "";
    this.reconnectTimer = null;
  }

  async sendFile(channelId, messageId, file) {
    const payload = JSON.stringify({
      message_reference: { message_id: messageId },
      allowed_mentions: { replied_user: false },
    });
    const multipart = encodeMultipart(
      { payload_json: payload },
      [{ field: "files[0]", fileName: file?.name || "export.bin", mimeType: exportMimeType(file?.format, file?.name), buffer: file?.buffer }],
    );
    const { response } = await safeFetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: { authorization: `Bot ${this.config.botToken}`, "content-type": multipart.contentType },
      body: multipart.body,
      accept: "application/json",
      timeoutMs: 60_000,
    });
    const body = (await readLimitedBody(response, 4 * 1024 * 1024)).toString("utf8");
    if (!response.ok) throw new Error(`Discord HTTP ${response.status}: ${body.slice(0, 160)}`);
    return body ? JSON.parse(body) : {};
  }

  async rest(path, options = {}) {
    const { response } = await safeFetch(`https://discord.com/api/v10${path}`, {
      method: options.method || "GET",
      headers: { authorization: `Bot ${this.config.botToken}`, "content-type": "application/json" },
      body: options.body ? JSON.stringify(options.body) : undefined,
      accept: "application/json", timeoutMs: 20_000,
    });
    const body = (await readLimitedBody(response, 4 * 1024 * 1024)).toString("utf8");
    if (!response.ok) throw new Error(`Discord HTTP ${response.status}: ${body.slice(0, 160)}`);
    return body ? JSON.parse(body) : {};
  }

  async connect() {
    const gateway = await this.rest("/gateway/bot");
    if (!this.running) return;
    this.socket = new WebSocket(`${gateway.url}?v=10&encoding=json`);
    this.socket.on("message", (raw) => void this.onPacket(raw));
    this.socket.on("error", (error) => this.setState("error", error.message));
    this.socket.on("close", () => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = null;
      this.socket = null;
      if (this.running) this.reconnectTimer = setTimeout(() => void this.connect().catch((error) => this.setState("error", error.message)), 4_000);
    });
  }

  send(packet) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(packet));
  }

  async onPacket(raw) {
    let packet;
    try { packet = JSON.parse(String(raw)); } catch (_) { return; }
    if (packet.s !== null && packet.s !== undefined) this.sequence = packet.s;
    if (packet.op === 10) {
      const interval = packet.d.heartbeat_interval;
      this.send({ op: 2, d: {
        token: this.config.botToken,
        intents: (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15),
        properties: { os: process.platform, browser: "omnichannel-diary", device: "omnichannel-diary" },
      } });
      this.heartbeat = setInterval(() => this.send({ op: 1, d: this.sequence }), interval);
      return;
    }
    if (packet.op === 1) this.send({ op: 1, d: this.sequence });
    if (packet.op === 7 || packet.op === 9) this.socket?.close();
    if (packet.op !== 0) return;
    if (packet.t === "READY") {
      this.botId = packet.d.user?.id || "";
      this.setState("connected", packet.d.user?.username || this.t("Discord 在线", "Discord online"));
      return;
    }
    if (packet.t !== "MESSAGE_CREATE") return;
    const message = packet.d;
    if (message.author?.bot || message.author?.id === this.botId) return;
    await this.deliver({
      id: message.id,
      timestamp: new Date(message.timestamp),
      senderId: message.author?.id || "discord-user",
      senderName: message.member?.nick || message.author?.global_name || message.author?.username || this.t("Discord 用户", "Discord user"),
      chatName: message.guild_id ? `Discord ${message.guild_id}/${message.channel_id}` : this.t("Discord 私聊", "Discord direct message"),
      isGroup: Boolean(message.guild_id),
      mentioned: (message.mentions || []).some((user) => user.id === this.botId),
      text: message.content || "",
      attachments: (message.attachments || []).map((file) => ({ fileName: file.filename, mimeType: file.content_type, url: file.url })),
      reply: async (text) => this.rest(`/channels/${message.channel_id}/messages`, {
        method: "POST", body: { content: text, message_reference: { message_id: message.id }, allowed_mentions: { replied_user: false } },
      }),
      replyFile: async (file) => this.sendFile(message.channel_id, message.id, file),
    });
  }

  async start() {
    this.assertFields(["botToken"]);
    this.running = true;
    this.setState("connecting", this.t("正在连接 Gateway", "Connecting to Gateway"));
    await this.connect();
  }

  async stop() {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.reconnectTimer = null;
    this.heartbeat = null;
    this.socket?.close();
    this.socket = null;
    this.setState("stopped");
  }
}

module.exports = { DiscordChannel };
