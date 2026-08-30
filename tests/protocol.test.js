"use strict";

const crypto = require("node:crypto");
const test = require("node:test");
const assert = require("node:assert/strict");
const { CHANNEL_VERSION, buildTextReply, clientVersion, headers, parseAesKey, randomUin } = require("../src/channels/wechat");
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

test("WeChat requests identify the app and encode the plugin protocol version", () => {
  const value = headers("");
  assert.equal(value["ilink-app-id"], "bot");
  assert.equal(value["ilink-app-clientversion"], String(clientVersion(CHANNEL_VERSION)));
  assert.equal(clientVersion("0.3.6"), 774);
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
