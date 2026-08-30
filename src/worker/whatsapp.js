"use strict";

const crypto = require("node:crypto");
const timers = require("node:timers");

function createOutboundReplyTracker({ maxAgeMs = 5 * 60 * 1000, maxEntries = 200 } = {}) {
  const entries = new Map();
  const prune = (now = Date.now()) => {
    for (const [id, timestamp] of entries) {
      if (now - timestamp <= maxAgeMs && entries.size <= maxEntries) break;
      entries.delete(id);
    }
  };
  return {
    remember(id, now = Date.now()) {
      if (!id) return;
      entries.set(id, now);
      prune(now);
    },
    consume(id, now = Date.now()) {
      prune(now);
      if (!id || !entries.has(id)) return false;
      entries.delete(id);
      return true;
    },
    forget(id) { entries.delete(id); },
    get size() { return entries.size; },
  };
}

function shouldCaptureMessage(message, options = {}) {
  if (!message?.message) return false;
  if (!message.key?.fromMe) return true;
  if (options.consumeOutboundReply?.(message.key?.id || "")) return false;
  const sameUser = options.sameUser || ((left, right) => left === right);
  const chatIds = [message.key?.remoteJid, message.key?.remoteJidAlt].filter(Boolean);
  const ownIds = (options.ownIds || []).filter(Boolean);
  return chatIds.some((chatId) => ownIds.some((ownId) => sameUser(chatId, ownId)));
}

function silentLogger() {
  const logger = { level: "silent", trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} };
  logger.child = () => logger;
  return logger;
}

function unwrapMessage(content) {
  let value = content || {};
  for (const key of ["ephemeralMessage", "viewOnceMessage", "viewOnceMessageV2", "documentWithCaptionMessage"]) {
    if (value[key]?.message) value = value[key].message;
  }
  return value;
}

function messageText(content) {
  return content.conversation
    || content.extendedTextMessage?.text
    || content.imageMessage?.caption
    || content.videoMessage?.caption
    || content.documentMessage?.caption
    || content.buttonsResponseMessage?.selectedDisplayText
    || content.listResponseMessage?.title
    || "";
}

function mediaInfo(content, id) {
  if (content.imageMessage) return { key: "imageMessage", fileName: content.imageMessage.fileName || `whatsapp-${id}.jpg`, mimeType: content.imageMessage.mimetype || "image/jpeg" };
  if (content.videoMessage) return { key: "videoMessage", fileName: content.videoMessage.fileName || `whatsapp-${id}.mp4`, mimeType: content.videoMessage.mimetype || "video/mp4" };
  if (content.audioMessage) return { key: "audioMessage", fileName: `whatsapp-${id}.ogg`, mimeType: content.audioMessage.mimetype || "audio/ogg" };
  if (content.documentMessage) return { key: "documentMessage", fileName: content.documentMessage.fileName || `whatsapp-${id}`, mimeType: content.documentMessage.mimetype || "application/octet-stream" };
  if (content.stickerMessage) return { key: "stickerMessage", fileName: `whatsapp-${id}.webp`, mimeType: content.stickerMessage.mimetype || "image/webp" };
  return null;
}

async function runWhatsAppWorker(options = {}) {
  const authDir = options.authDir;
  const emit = options.send;
  const english = options.locale === "en";
  const tr = (zh, en) => english ? en : zh;
  if (!authDir) throw new Error("WhatsApp auth directory is missing");
  if (typeof emit !== "function" || typeof options.onMessage !== "function") throw new Error("WhatsApp runtime transport is missing");
  const cacheModule = await import("@cacheable/node-cache");
  const NodeCache = cacheModule.default || cacheModule.NodeCache;
  if (NodeCache?.prototype && !NodeCache.prototype.__omnichannelDiaryTimerPatch) {
    Object.defineProperty(NodeCache.prototype, "__omnichannelDiaryTimerPatch", { value: true });
    NodeCache.prototype.startInterval = function startIntervalWithNodeTimer() {
      if (!this.options.checkperiod || this.options.checkperiod <= 0) {
        this.intervalId = 0;
        return;
      }
      this.intervalId = timers.setInterval(() => this.checkData(), this.options.checkperiod * 1_000);
      this.intervalId.unref();
    };
    NodeCache.prototype.stopInterval = function stopIntervalWithNodeTimer() {
      if (this.intervalId !== 0) timers.clearInterval(this.intervalId);
      this.intervalId = 0;
    };
  }
  const baileys = await import("@whiskeysockets/baileys");
  const makeSocket = baileys.default || baileys.makeWASocket;
  const logger = silentLogger();
  let socket;
  let stopped = false;
  const outboundReplies = createOutboundReplyTracker();
  let closeRuntime;
  const runtimeClosed = new Promise((resolve) => { closeRuntime = resolve; });

  const connect = async () => {
    if (stopped) return;
    const { state, saveCreds } = await baileys.useMultiFileAuthState(authDir);
    const versionResult = await baileys.fetchLatestBaileysVersion();
    socket = makeSocket({
      auth: state,
      version: versionResult.version,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      logger,
      getMessage: async () => undefined,
    });

    socket.ev.on("creds.update", saveCreds);
    socket.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
      if (qr) emit({ type: "qr", value: qr });
      if (connection === "open") emit({ type: "status", state: "connected", detail: socket.user?.name || socket.user?.id || tr("WhatsApp 在线", "WhatsApp online") });
      if (connection === "close" && !stopped) {
        const code = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.data?.statusCode;
        if (code === 401) emit({ type: "status", state: "error", detail: tr("WhatsApp 登录已失效，请重新扫码", "WhatsApp login expired. Scan a new QR code") });
        else {
          emit({ type: "status", state: "connecting", detail: tr("WhatsApp 正在重连", "WhatsApp reconnecting") });
          setTimeout(() => void connect().catch((error) => emit({ type: "fatal", message: error?.message || String(error) })), 2_500);
        }
      }
    });

    socket.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const message of messages || []) {
        const ownIds = [socket.user?.id, socket.user?.lid, socket.user?.phoneNumber];
        if (!shouldCaptureMessage(message, {
          ownIds,
          sameUser: baileys.areJidsSameUser,
          consumeOutboundReply: (id) => outboundReplies.consume(id),
        })) continue;
        try {
          const content = unwrapMessage(message.message);
          const id = message.key?.id || `${Date.now()}`;
          const media = mediaInfo(content, id);
          const attachments = [];
          if (media) {
            const buffer = await baileys.downloadMediaMessage(message, "buffer", {}, { logger, reuploadRequest: socket.updateMediaMessage });
            if (buffer.length <= 25 * 1024 * 1024) attachments.push({ ...media, base64: buffer.toString("base64") });
            else attachments.push({ ...media, error: tr("附件超过 25 MB，未保存", "Attachment exceeds 25 MB and was not saved") });
          }
          const jid = message.key?.remoteJid || "";
          const fromSelf = Boolean(message.key?.fromMe);
          emit({
            type: "message",
            value: {
              id,
              timestamp: Number(message.messageTimestamp || 0) * 1000 || Date.now(),
              senderId: fromSelf ? (socket.user?.id || "whatsapp-self") : (message.key?.participant || jid),
              senderName: fromSelf ? (socket.user?.name || socket.user?.notify || tr("本人", "Me")) : (message.pushName || message.key?.participant || jid),
              chatName: fromSelf ? tr("给自己发消息", "Message yourself") : jid,
              isGroup: jid.endsWith("@g.us"),
              text: messageText(content),
              attachments,
              replyTarget: jid,
            },
          });
        } catch (error) {
          emit({ type: "status", state: "error", detail: `${tr("WhatsApp 消息处理失败：", "WhatsApp message processing failed: ")}${error?.message || error}` });
        }
      }
    });
  };

  const onMessage = async (message) => {
    if (message?.type === "reply" && socket && message.jid) {
      const messageId = crypto.randomBytes(10).toString("hex").toUpperCase();
      outboundReplies.remember(messageId);
      try { await socket.sendMessage(message.jid, { text: String(message.text || "") }, { messageId }); }
      catch (error) {
        outboundReplies.forget(messageId);
        emit({ type: "status", state: "error", detail: `${tr("WhatsApp 回复失败：", "WhatsApp reply failed: ")}${error?.message || error}` });
        throw error;
      }
    }
    if (message?.type === "stop") {
      stopped = true;
      try { socket?.end(undefined); } catch (_) {}
      if (options.stop) options.stop();
      closeRuntime();
    }
  };
  options.onMessage(onMessage);
  await connect();
  if (!stopped) await runtimeClosed;
}

module.exports = { createOutboundReplyTracker, mediaInfo, messageText, runWhatsAppWorker, shouldCaptureMessage, unwrapMessage };
