"use strict";

function getArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function send(message) {
  if (process.send) process.send(message);
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

async function runWhatsAppWorker() {
  const authDir = getArg("--auth-dir");
  if (!authDir) throw new Error("WhatsApp auth directory is missing");
  const baileys = await import("@whiskeysockets/baileys");
  const makeSocket = baileys.default || baileys.makeWASocket;
  const logger = silentLogger();
  let socket;
  let stopped = false;

  const connect = async () => {
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
      if (qr) send({ type: "qr", value: qr });
      if (connection === "open") send({ type: "status", state: "connected", detail: socket.user?.name || socket.user?.id || "WhatsApp 在线" });
      if (connection === "close" && !stopped) {
        const code = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.data?.statusCode;
        if (code === 401) send({ type: "status", state: "error", detail: "WhatsApp 登录已失效，请重新扫码" });
        else {
          send({ type: "status", state: "connecting", detail: "WhatsApp 正在重连" });
          setTimeout(() => void connect().catch((error) => send({ type: "fatal", message: error?.message || String(error) })), 2_500);
        }
      }
    });

    socket.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const message of messages || []) {
        if (!message.message || message.key?.fromMe) continue;
        try {
          const content = unwrapMessage(message.message);
          const id = message.key?.id || `${Date.now()}`;
          const media = mediaInfo(content, id);
          const attachments = [];
          if (media) {
            const buffer = await baileys.downloadMediaMessage(message, "buffer", {}, { logger, reuploadRequest: socket.updateMediaMessage });
            if (buffer.length <= 25 * 1024 * 1024) attachments.push({ ...media, base64: buffer.toString("base64") });
            else attachments.push({ ...media, error: "附件超过 25 MB，未通过进程边界传输" });
          }
          const jid = message.key?.remoteJid || "";
          send({
            type: "message",
            value: {
              id,
              timestamp: Number(message.messageTimestamp || 0) * 1000 || Date.now(),
              senderId: message.key?.participant || jid,
              senderName: message.pushName || message.key?.participant || jid,
              chatName: jid,
              isGroup: jid.endsWith("@g.us"),
              text: messageText(content),
              attachments,
              replyTarget: jid,
            },
          });
        } catch (error) {
          send({ type: "status", state: "error", detail: `WhatsApp 消息处理失败：${error?.message || error}` });
        }
      }
    });
  };

  process.on("message", async (message) => {
    if (message?.type === "reply" && socket && message.jid) {
      try { await socket.sendMessage(message.jid, { text: String(message.text || "") }); }
      catch (error) { send({ type: "status", state: "error", detail: `WhatsApp 回复失败：${error?.message || error}` }); }
    }
    if (message?.type === "stop") {
      stopped = true;
      try { socket?.end(undefined); } catch (_) {}
      process.exit(0);
    }
  });
  process.on("disconnect", () => {
    stopped = true;
    try { socket?.end(undefined); } catch (_) {}
    process.exit(0);
  });
  await connect();
}

module.exports = { getArg, mediaInfo, messageText, runWhatsAppWorker, unwrapMessage };
