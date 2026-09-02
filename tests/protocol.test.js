"use strict";

const crypto = require("node:crypto");
const test = require("node:test");
const assert = require("node:assert/strict");
const { CHANNEL_VERSION, buildFileReply, buildTextReply, clientVersion, headers, isOfficialWechatRemoteUrl, parseAesKey, randomUin } = require("../src/channels/wechat");
const { encodeMultipart, exportMimeType } = require("../src/core/util");
const { FeishuApiClient } = require("../src/channels/feishu");
const { createOutboundReplyTracker, messageText, mediaInfo, shouldCaptureMessage, unwrapMessage } = require("../src/worker/whatsapp");

test("WeChat media keys accept raw base64 and base64-encoded hex", () => {
  const key = crypto.randomBytes(16);
  assert.deepEqual(parseAesKey(key.toString("base64")), key);
  assert.deepEqual(parseAesKey(Buffer.from(key.toString("hex")).toString("base64")), key);
  assert.deepEqual(parseAesKey("", key.toString("hex")), key);
});

test("WeChat UIN header decodes to an unsigned integer", () => {
  assert.match(Buffer.from(randomUin(), "base64").toString("utf8"), /^\d+$/);
});

test("WeChat reply payload contains every field required for downstream delivery", () => {
  const payload = buildTextReply({ from_user_id: "user@im.wechat", context_token: "context" }, "saved", "omnichannel-diary:test");
  assert.deepEqual(payload, {
    msg: {
      from_user_id: "",
      to_user_id: "user@im.wechat",
      client_id: "omnichannel-diary:test",
      message_type: 2,
      message_state: 2,
      context_token: "context",
      item_list: [{ type: 1, text_item: { text: "saved" } }],
    },
  });
  assert.throws(() => buildTextReply({ from_user_id: "user@im.wechat" }, "saved"), /context_token/);
});

test("WeChat file replies use media_type 3 and file_item type 4", () => {
  const payload = buildFileReply(
    { from_user_id: "user@im.wechat", context_token: "CTX" },
    { name: "Obsidian-人工智能-20260902.md", buffer: Buffer.from("hello-md") },
    "ENC_PARAM",
    Buffer.from("0123456789abcdef"),
    "omnichannel-diary:file",
  );
  const item = payload.msg.item_list[0];
  assert.equal(payload.msg.context_token, "CTX");
  assert.equal(payload.msg.to_user_id, "user@im.wechat");
  assert.equal(item.type, 4);
  assert.equal(item.file_item.file_name, "Obsidian-人工智能-20260902.md");
  assert.equal(item.file_item.file_ext, "md");
  assert.equal(item.file_item.md5, crypto.createHash("md5").update("hello-md").digest("hex"));
  assert.equal(item.file_item.len, "8");
  assert.equal(item.file_item.media.encrypt_query_param, "ENC_PARAM");
  assert.equal(item.file_item.media.encrypt_type, 1);
  assert.equal(item.file_item.media.aes_key, Buffer.from(Buffer.from("0123456789abcdef").toString("hex")).toString("base64"));
});

test("multipart exports keep the original filename and binary payload", () => {
  const packed = encodeMultipart(
    { chat_id: "123" },
    [{ field: "document", fileName: "notes.md", mimeType: exportMimeType("md"), buffer: Buffer.from("hello") }],
  );
  const body = packed.body.toString("latin1");
  assert.match(packed.contentType, /multipart\/form-data; boundary=/);
  assert.match(body, /name="chat_id"/);
  assert.match(body, /filename="notes.md"/);
  assert.match(body, /Content-Type: text\/markdown/);
  assert.match(body, /hello/);
});

test("Feishu file replies upload stream files then send file_key", async () => {
  const calls = [];
  const { Readable } = require("node:stream");
  const http = {
    post: async (url, data, options) => {
      calls.push({ kind: "http", url, data, options });
      if (url.endsWith("/tenant_access_token/internal")) return { code: 0, tenant_access_token: "tenant-token", expire: 7200 };
      return { code: 0, data: { message_id: "msg-1" } };
    },
  };
  const client = new FeishuApiClient({ appId: "cli_test", appSecret: "secret" }, "https://open.feishu.cn/", http, {
    fetch: async (url, options) => {
      calls.push({ kind: "fetch", url, options });
      const payload = Buffer.from(JSON.stringify({ code: 0, data: { file_key: "file-1" } }));
      const stream = Readable.from([payload]);
      return {
        response: {
          ok: true,
          status: 200,
          headers: { get: () => null },
          body: stream,
        },
      };
    },
  });
  await client.replyFile("chat id", { name: "notes.md", buffer: Buffer.from("hello") });
  const upload = calls.find((call) => call.kind === "fetch");
  assert.match(upload.url, /\/open-apis\/im\/v1\/files$/);
  assert.match(upload.options.headers["content-type"], /multipart\/form-data; boundary=/);
  assert.match(upload.options.body.toString("latin1"), /filename="notes.md"/);
  assert.match(upload.options.body.toString("latin1"), /name="file_type"/);
  const send = calls.find((call) => call.kind === "http" && call.data?.msg_type === "file");
  assert.equal(JSON.parse(send.data.content).file_key, "file-1");
});

test("WeChat requests identify the app and encode the plugin protocol version", () => {
  const value = headers("");
  assert.equal(value["ilink-app-id"], "bot");
  assert.equal(value["ilink-app-clientversion"], String(clientVersion(CHANNEL_VERSION)));
  assert.equal(clientVersion("0.3.6"), 774);
});

test("WeChat synthetic-address compatibility is limited to official HTTPS hosts", () => {
  assert.equal(isOfficialWechatRemoteUrl("https://ilinkai.weixin.qq.com/ilink/bot/getupdates"), true);
  assert.equal(isOfficialWechatRemoteUrl("https://novac2c.cdn.weixin.qq.com/c2c/download"), true);
  assert.equal(isOfficialWechatRemoteUrl("https://liteapp.weixin.qq.com/path"), true);
  assert.equal(isOfficialWechatRemoteUrl("http://ilinkai.weixin.qq.com/path"), false);
  assert.equal(isOfficialWechatRemoteUrl("https://weixin.qq.com.evil.example/path"), false);
  assert.equal(isOfficialWechatRemoteUrl("https://127.0.0.1/path"), false);
});

test("WhatsApp runtime normalizes wrapped text and media metadata", () => {
  const wrapped = { ephemeralMessage: { message: { imageMessage: { caption: "caption", mimetype: "image/png" } } } };
  const content = unwrapMessage(wrapped);
  assert.equal(messageText(content), "caption");
  assert.deepEqual(mediaInfo(content, "abc"), { key: "imageMessage", fileName: "whatsapp-abc.jpg", mimeType: "image/png" });
});

test("WhatsApp captures incoming and message-yourself traffic without watching ordinary outgoing chats", () => {
  const sameUser = (left, right) => String(left).split("@")[0].split(":")[0] === String(right).split("@")[0].split(":")[0];
  const options = { ownIds: ["13800138000:12@s.whatsapp.net"], sameUser };
  assert.equal(shouldCaptureMessage({ key: { fromMe: false, remoteJid: "13900139000@s.whatsapp.net" }, message: { conversation: "incoming" } }, options), true);
  assert.equal(shouldCaptureMessage({ key: { fromMe: true, remoteJid: "13800138000@s.whatsapp.net" }, message: { conversation: "save this" } }, options), true);
  assert.equal(shouldCaptureMessage({ key: { fromMe: true, remoteJid: "13900139000@s.whatsapp.net" }, message: { conversation: "private outgoing" } }, options), false);
  assert.equal(shouldCaptureMessage({ key: { fromMe: true, remoteJid: "12345@g.us" }, message: { conversation: "group outgoing" } }, options), false);
});

test("WhatsApp ignores only plugin-generated receipts and bounds the receipt tracker", () => {
  const tracker = createOutboundReplyTracker({ maxAgeMs: 1_000, maxEntries: 2 });
  tracker.remember("receipt-1", 0);
  tracker.remember("receipt-2", 10);
  tracker.remember("receipt-3", 20);
  assert.equal(tracker.size, 2);
  const options = {
    ownIds: ["me@s.whatsapp.net"],
    sameUser: (left, right) => left === right,
    consumeOutboundReply: (id) => tracker.consume(id, 20),
  };
  assert.equal(shouldCaptureMessage({ key: { id: "receipt-3", fromMe: true, remoteJid: "me@s.whatsapp.net" }, message: { conversation: "saved" } }, options), false);
  assert.equal(tracker.size, 1);
  assert.equal(shouldCaptureMessage({ key: { id: "user-message", fromMe: true, remoteJid: "me@s.whatsapp.net" }, message: { conversation: "clip" } }, options), true);
});
