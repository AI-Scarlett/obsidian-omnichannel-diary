"use strict";

const crypto = require("node:crypto");
const test = require("node:test");
const assert = require("node:assert/strict");
const { CHANNEL_VERSION, buildTextReply, clientVersion, headers, parseAesKey, randomUin } = require("../src/channels/wechat");
const { messageText, mediaInfo, unwrapMessage } = require("../src/worker/whatsapp");

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
  assert.equal(clientVersion("0.3.4"), 772);
});

test("WhatsApp runtime normalizes wrapped text and media metadata", () => {
  const wrapped = { ephemeralMessage: { message: { imageMessage: { caption: "caption", mimetype: "image/png" } } } };
  const content = unwrapMessage(wrapped);
  assert.equal(messageText(content), "caption");
  assert.deepEqual(mediaInfo(content, "abc"), { key: "imageMessage", fileName: "whatsapp-abc.jpg", mimeType: "image/png" });
});
