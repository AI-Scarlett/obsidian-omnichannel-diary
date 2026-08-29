"use strict";

const { BaseChannel } = require("./base");
const { readLimitedBody, safeFetch } = require("../core/network");

class TelegramChannel extends BaseChannel {
  constructor(config, context) {
    super("telegram", config, context);
    this.abortController = null;
  }

  async api(method, data = {}, signal) {
    const { response } = await safeFetch(`https://api.telegram.org/bot${this.config.botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
      accept: "application/json",
      timeoutMs: method === "getUpdates" ? 45_000 : 20_000,
      signal,
    });
    const result = JSON.parse((await readLimitedBody(response, 4 * 1024 * 1024)).toString("utf8"));
    if (!response.ok || !result.ok) throw new Error(result.description || `Telegram HTTP ${response.status}`);
    return result.result;
  }

  async attachment(fileId, fileName, mimeType) {
    const file = await this.api("getFile", { file_id: fileId });
    return {
      fileName,
      mimeType,
      url: `https://api.telegram.org/file/bot${this.config.botToken}/${file.file_path}`,
    };
  }

  async normalize(update) {
    const message = update.message || update.channel_post;
    if (!message) return null;
    const attachments = [];
    if (message.photo?.length) {
      const photo = message.photo[message.photo.length - 1];
      attachments.push(await this.attachment(photo.file_id, `telegram-${message.message_id}.jpg`, "image/jpeg"));
    }
    for (const [key, fallbackMime] of [["document", "application/octet-stream"], ["audio", "audio/mpeg"], ["voice", "audio/ogg"], ["video", "video/mp4"], ["animation", "image/gif"]]) {
      const item = message[key];
      if (item?.file_id) attachments.push(await this.attachment(item.file_id, item.file_name || `telegram-${key}-${message.message_id}`, item.mime_type || fallbackMime));
    }
    const chat = message.chat || {};
    const sender = message.from || message.sender_chat || {};
    return {
      id: String(message.message_id),
      timestamp: new Date(Number(message.date || 0) * 1000 || Date.now()),
      senderId: String(sender.id || "telegram-user"),
      senderName: [sender.first_name, sender.last_name].filter(Boolean).join(" ") || sender.title || sender.username || "Telegram 用户",
      chatName: chat.title || chat.username || String(chat.id || "Telegram 私聊"),
      isGroup: ["group", "supergroup", "channel"].includes(chat.type),
      text: message.text || message.caption || "",
      attachments,
      reply: async (text) => this.api("sendMessage", { chat_id: chat.id, text, reply_parameters: { message_id: message.message_id } }),
    };
  }

  async start() {
    this.assertFields(["botToken"]);
    this.running = true;
    this.abortController = new AbortController();
    const identity = await this.api("getMe");
    this.setState("connected", `@${identity.username || identity.first_name}`);
    void this.poll(this.abortController.signal);
  }

  async poll(signal) {
    let retryMs = 1_000;
    while (this.running && !signal.aborted) {
      try {
        const updates = await this.api("getUpdates", {
          offset: Number(this.config.offset || 0), timeout: 30,
          allowed_updates: ["message", "channel_post"],
        }, signal);
        for (const update of updates) {
          this.config.offset = update.update_id + 1;
          const envelope = await this.normalize(update);
          if (envelope) await this.deliver(envelope);
        }
        if (updates.length) await this.context.saveSettings();
        retryMs = 1_000;
      } catch (error) {
        if (signal.aborted) break;
        this.setState("error", `Telegram 重试中：${error?.message || error}`);
        await new Promise((resolve) => setTimeout(resolve, retryMs));
        retryMs = Math.min(30_000, retryMs * 2);
      }
    }
  }

  async stop() {
    this.running = false;
    this.abortController?.abort();
    this.abortController = null;
    this.setState("stopped");
  }
}

module.exports = { TelegramChannel };
