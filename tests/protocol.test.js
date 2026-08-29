"use strict";

const crypto = require("node:crypto");
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseAesKey, randomUin } = require("../src/channels/wechat");
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

test("WhatsApp runtime normalizes wrapped text and media metadata", () => {
  const wrapped = { ephemeralMessage: { message: { imageMessage: { caption: "caption", mimetype: "image/png" } } } };
  const content = unwrapMessage(wrapped);
  assert.equal(messageText(content), "caption");
  assert.deepEqual(mediaInfo(content, "abc"), { key: "imageMessage", fileName: "whatsapp-abc.jpg", mimeType: "image/png" });
});
