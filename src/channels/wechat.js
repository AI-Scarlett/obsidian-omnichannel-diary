"use strict";

const crypto = require("node:crypto");
const { BaseChannel } = require("./base");
const { readLimitedBody, safeFetch } = require("../core/network");

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

function randomUin() {
  return Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), "utf8").toString("base64");
}

function parseAesKey(value, preferredHex) {
  if (preferredHex && /^[a-f0-9]{32}$/i.test(preferredHex)) return Buffer.from(preferredHex, "hex");
  const decoded = Buffer.from(String(value || ""), "base64");
  if (decoded.length === 16) return decoded;
  const text = decoded.toString("utf8");
  if (/^[a-f0-9]{32}$/i.test(text)) return Buffer.from(text, "hex");
  throw new Error("Unsupported WeChat media key");
}

async function downloadIlinkMedia(media, preferredHex) {
  if (!media) throw new Error("WeChat media reference is missing");
  const url = media.full_url || `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param || "")}`;
  const { response } = await safeFetch(url, { accept: "application/octet-stream", timeoutMs: 30_000 });
  if (!response.ok) throw new Error(`WeChat CDN returned HTTP ${response.status}`);
  const encrypted = await readLimitedBody(response, 100 * 1024 * 1024);
  const decipher = crypto.createDecipheriv("aes-128-ecb", parseAesKey(media.aes_key, preferredHex), null);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

function headers(token) {
  return {
    "content-type": "application/json",
    authorizationtype: "ilink_bot_token",
    "x-wechat-uin": randomUin(),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function ilinkJson(baseUrl, endpoint, options = {}) {
  const body = options.body === undefined ? undefined : JSON.stringify({
    ...options.body,
    base_info: { channel_version: "2.1.0", bot_agent: "OmnichannelDiary/0.3.0" },
  });
  const { response } = await safeFetch(`${String(baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "")}/${endpoint.replace(/^\//, "")}`, {
    method: options.method || (body ? "POST" : "GET"),
    headers: headers(options.token),
    body,
    accept: "application/json",
    timeoutMs: options.timeoutMs || 45_000,
    signal: options.signal,
  });
  const text = (await readLimitedBody(response, 2 * 1024 * 1024)).toString("utf8");
  if (!response.ok) throw new Error(`WeChat API returned HTTP ${response.status}`);
  const parsed = JSON.parse(text || "{}");
  if (parsed.ret && parsed.ret !== 0) throw new Error(parsed.errmsg || `WeChat API error ${parsed.ret}`);
  return parsed;
}

function itemText(item) {
  return item?.text_item?.text || item?.voice_item?.text || "";
}

function itemAttachment(item, index) {
  if (item?.type === 2 && item.image_item?.media) {
    return {
      fileName: `wechat-image-${index + 1}.jpg`, mimeType: "image/jpeg",
      load: async () => ({ buffer: await downloadIlinkMedia(item.image_item.media, item.image_item.aeskey), fileName: `wechat-image-${index + 1}.jpg`, mimeType: "image/jpeg" }),
    };
  }
  if (item?.type === 3 && item.voice_item?.media) {
    return {
      fileName: `wechat-voice-${index + 1}.silk`, mimeType: "audio/silk",
      load: async () => ({ buffer: await downloadIlinkMedia(item.voice_item.media), fileName: `wechat-voice-${index + 1}.silk`, mimeType: "audio/silk" }),
    };
  }
  if (item?.type === 4 && item.file_item?.media) {
    const fileName = item.file_item.file_name || `wechat-file-${index + 1}`;
    return { fileName, load: async () => ({ buffer: await downloadIlinkMedia(item.file_item.media), fileName, mimeType: "application/octet-stream" }) };
  }
  if (item?.type === 5 && item.video_item?.media) {
    return {
      fileName: `wechat-video-${index + 1}.mp4`, mimeType: "video/mp4",
      load: async () => ({ buffer: await downloadIlinkMedia(item.video_item.media), fileName: `wechat-video-${index + 1}.mp4`, mimeType: "video/mp4" }),
    };
  }
  return null;
}

class WeChatChannel extends BaseChannel {
  constructor(config, context) {
    super("wechat", config, context);
    this.abortController = null;
  }

  async beginPairing(callbacks = {}) {
    let baseUrl = DEFAULT_BASE_URL;
    callbacks.onStatus?.("正在生成微信二维码…");
    const qr = await ilinkJson(baseUrl, "ilink/bot/get_bot_qrcode?bot_type=3", {
      method: "POST",
      body: { local_token_list: this.config.token ? [this.config.token] : [] },
      timeoutMs: 30_000,
    });
    if (!qr.qrcode || !qr.qrcode_img_content) throw new Error("微信服务没有返回二维码");
    callbacks.onQr?.(qr.qrcode_img_content);
    callbacks.onStatus?.("请用微信扫码并在手机上确认");
    const deadline = Date.now() + 8 * 60_000;
    while (Date.now() < deadline) {
      const status = await ilinkJson(baseUrl, `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr.qrcode)}`, { timeoutMs: 40_000 });
      if (status.status === "scaned") callbacks.onStatus?.("已扫码，请在微信中确认");
      if (status.status === "scaned_but_redirect" && status.redirect_host) {
        baseUrl = `https://${String(status.redirect_host).replace(/^https?:\/\//, "")}`;
      } else if (status.status === "need_verifycode" || status.status === "verify_code_blocked") {
        throw new Error("微信要求输入配对码；请在微信端完成验证后重新扫码");
      } else if (status.status === "expired") {
        throw new Error("微信二维码已过期，请重新生成");
      } else if (status.status === "confirmed") {
        if (!status.bot_token) throw new Error("微信确认成功但未返回连接凭据");
        Object.assign(this.config, {
          token: status.bot_token,
          accountId: status.ilink_bot_id || "",
          userId: status.ilink_user_id || "",
          baseUrl: status.baseurl || baseUrl,
          syncBuf: "",
          enabled: true,
        });
        await this.context.saveSettings();
        callbacks.onStatus?.("微信已连接");
        return this.config;
      }
      await new Promise((resolve) => setTimeout(resolve, 900));
    }
    throw new Error("微信扫码等待超时");
  }

  async start() {
    this.assertFields(["token"]);
    this.running = true;
    this.abortController = new AbortController();
    this.setState("connecting", "正在建立长轮询");
    void this.poll(this.abortController.signal);
  }

  async poll(signal) {
    let retryMs = 1_000;
    while (this.running && !signal.aborted) {
      try {
        const result = await ilinkJson(this.config.baseUrl || DEFAULT_BASE_URL, "ilink/bot/getupdates", {
          body: { get_updates_buf: this.config.syncBuf || "" }, token: this.config.token, timeoutMs: 50_000, signal,
        });
        if (result.get_updates_buf !== undefined) {
          this.config.syncBuf = result.get_updates_buf;
          await this.context.saveSettings();
        }
        this.setState("connected", "微信 iLink 在线");
        retryMs = 1_000;
        for (const message of result.msgs || []) {
          if (message.message_type !== 1) continue;
          const items = message.item_list || [];
          const attachments = items.map(itemAttachment).filter(Boolean);
          await this.deliver({
            id: String(message.message_id || message.seq || `${message.from_user_id}-${message.create_time_ms}`),
            timestamp: new Date(Number(message.create_time_ms) || Date.now()),
            senderId: message.from_user_id || "wechat-user",
            senderName: message.from_user_id || "微信用户",
            chatName: message.session_id || "微信私聊",
            text: items.map(itemText).filter(Boolean).join("\n"),
            attachments,
            reply: async (text) => ilinkJson(this.config.baseUrl || DEFAULT_BASE_URL, "ilink/bot/sendmessage", {
              token: this.config.token,
              body: { msg: { to_user_id: message.from_user_id, context_token: message.context_token, item_list: [{ type: 1, text_item: { text } }] } },
            }),
          });
        }
      } catch (error) {
        if (signal.aborted) break;
        this.setState("error", `微信连接重试中：${error?.message || error}`);
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

module.exports = { WeChatChannel, downloadIlinkMedia, ilinkJson, parseAesKey, randomUin };
