"use strict";

const crypto = require("node:crypto");
const { BaseChannel } = require("./base");
const { readLimitedBody, safeFetch } = require("../core/network");

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const CHANNEL_VERSION = "0.3.4";
const ILINK_APP_ID = "bot";

function clientVersion(value) {
  const parts = String(value).split(".").map((part) => Number.parseInt(part, 10) || 0);
  return ((parts[0] & 0xff) << 16) | ((parts[1] & 0xff) << 8) | (parts[2] & 0xff);
}

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
    "ilink-app-id": ILINK_APP_ID,
    "ilink-app-clientversion": String(clientVersion(CHANNEL_VERSION)),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

function replyClientId() {
  return `omnichannel-diary:${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
}

function buildTextReply(message, text, clientId = replyClientId()) {
  if (!message?.from_user_id) throw new Error("微信消息缺少发送者 ID，无法回复");
  if (!message?.context_token) throw new Error("微信消息缺少 context_token，无法回复");
  return {
    msg: {
      from_user_id: "",
      to_user_id: message.from_user_id,
      client_id: clientId,
      message_type: 2,
      message_state: 2,
      context_token: message.context_token,
      item_list: [{ type: 1, text_item: { text: String(text || "") } }],
    },
  };
}

async function ilinkJson(baseUrl, endpoint, options = {}) {
  const body = options.body === undefined ? undefined : JSON.stringify({
    ...options.body,
    base_info: { channel_version: CHANNEL_VERSION, bot_agent: `OmnichannelDiary/${CHANNEL_VERSION}` },
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
    this.pairingAbort = null;
  }

  async beginPairing(callbacks = {}) {
    const controller = new AbortController();
    this.pairingAbort = controller;
    let baseUrl = DEFAULT_BASE_URL;
    try {
      callbacks.onStatus?.(this.t("正在生成微信二维码…", "Generating a WeChat QR code…"));
      const qr = await ilinkJson(baseUrl, "ilink/bot/get_bot_qrcode?bot_type=3", {
        method: "POST",
        body: { local_token_list: this.config.token ? [this.config.token] : [] },
        timeoutMs: 30_000,
        signal: controller.signal,
      });
      if (!qr.qrcode || !qr.qrcode_img_content) throw new Error(this.t("微信服务没有返回二维码", "WeChat did not return a QR code"));
      callbacks.onQr?.(qr.qrcode_img_content);
      callbacks.onStatus?.(this.t("请用微信扫码并在手机上确认", "Scan with WeChat and confirm on your phone"));
      const deadline = Date.now() + 8 * 60_000;
      while (Date.now() < deadline && !controller.signal.aborted) {
        const status = await ilinkJson(baseUrl, `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr.qrcode)}`, { timeoutMs: 40_000, signal: controller.signal });
        if (status.status === "scaned") callbacks.onStatus?.(this.t("已扫码，请在微信中确认", "QR scanned. Confirm in WeChat"));
        if (status.status === "scaned_but_redirect" && status.redirect_host) {
          baseUrl = `https://${String(status.redirect_host).replace(/^https?:\/\//, "")}`;
        } else if (status.status === "need_verifycode" || status.status === "verify_code_blocked") {
          throw new Error(this.t("微信要求输入配对码；请在微信端完成验证后重新扫码", "WeChat requires a pairing code. Complete verification in WeChat, then scan again"));
        } else if (status.status === "expired") {
          throw new Error(this.t("微信二维码已过期，请重新生成", "The WeChat QR code expired. Generate a new one"));
        } else if (status.status === "confirmed") {
          if (!status.bot_token) throw new Error(this.t("微信确认成功但未返回连接凭据", "WeChat confirmed authorization but returned no connection credentials"));
          Object.assign(this.config, {
            token: status.bot_token,
            accountId: status.ilink_bot_id || "",
            userId: status.ilink_user_id || "",
            baseUrl: status.baseurl || baseUrl,
            syncBuf: "",
            enabled: true,
          });
          await this.context.saveSettings();
          callbacks.onStatus?.(this.t("微信已连接", "WeChat connected"));
          return this.config;
        }
        await new Promise((resolve) => setTimeout(resolve, 900));
      }
      if (controller.signal.aborted) throw new Error(this.t("微信连接已取消", "WeChat connection cancelled"));
      throw new Error(this.t("微信扫码等待超时", "WeChat QR scan timed out"));
    } finally {
      if (this.pairingAbort === controller) this.pairingAbort = null;
    }
  }

  async start() {
    this.assertFields(["token"]);
    this.running = true;
    this.abortController = new AbortController();
    this.setState("connecting", this.t("正在建立长轮询", "Starting long polling"));
    void this.poll(this.abortController.signal);
  }

  async poll(signal) {
    let retryMs = 1_000;
    while (this.running && !signal.aborted) {
      try {
        const result = await ilinkJson(this.config.baseUrl || DEFAULT_BASE_URL, "ilink/bot/getupdates", {
          body: { get_updates_buf: this.config.syncBuf || "" }, token: this.config.token, timeoutMs: 50_000, signal,
        });
        await this.processUpdate(result);
        this.setState("connected", this.t("微信 iLink 在线", "WeChat iLink online"));
        retryMs = 1_000;
      } catch (error) {
        if (signal.aborted) break;
        this.setState("error", this.t("微信连接重试中：{error}", "Retrying WeChat connection: {error}", { error: error?.message || error }));
        await new Promise((resolve) => setTimeout(resolve, retryMs));
        retryMs = Math.min(30_000, retryMs * 2);
      }
    }
  }

  async processUpdate(result) {
    for (const message of result.msgs || []) {
      if (message.message_type !== 1) continue;
      const items = message.item_list || [];
      const attachments = items.map(itemAttachment).filter(Boolean);
      const outboundClientId = replyClientId();
      const delivery = await this.deliver({
        id: String(message.message_id || message.seq || `${message.from_user_id}-${message.create_time_ms}`),
        timestamp: new Date(Number(message.create_time_ms) || Date.now()),
        senderId: message.from_user_id || "wechat-user",
        senderName: message.from_user_id || this.t("微信用户", "WeChat user"),
        chatName: message.session_id || this.t("微信私聊", "WeChat direct message"),
        text: items.map(itemText).filter(Boolean).join("\n"),
        attachments,
        reply: async (text) => ilinkJson(this.config.baseUrl || DEFAULT_BASE_URL, "ilink/bot/sendmessage", {
          token: this.config.token,
          body: buildTextReply(message, text, outboundClientId),
        }),
      });
      if (delivery?.ok === false) throw delivery.error;
    }
    if (result.get_updates_buf !== undefined) {
      this.config.syncBuf = result.get_updates_buf;
      await this.context.saveSettings();
    }
  }

  async stop() {
    this.running = false;
    this.pairingAbort?.abort();
    this.pairingAbort = null;
    this.abortController?.abort();
    this.abortController = null;
    this.setState("stopped");
  }
}

module.exports = { CHANNEL_VERSION, WeChatChannel, buildTextReply, clientVersion, downloadIlinkMedia, headers, ilinkJson, parseAesKey, randomUin, replyClientId };
