"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { CaptureRouter, HELP_TEXT } = require("../src/core/router");

test("help and status are deterministic and never invoke capture", async () => {
  let captures = 0;
  const replies = [];
  const router = new CaptureRouter({ capture: async () => { captures += 1; } }, () => ({ telegram: { state: "connected" } }));
  await router.handle({ text: "/help", reply: async (text) => replies.push(text) });
  await router.handle({ text: "/status", reply: async (text) => replies.push(text) });
  assert.equal(captures, 0);
  assert.equal(replies[0], HELP_TEXT);
  assert.match(replies[1], /1 个渠道在线/);
});

test("clip command passes only the URL to diary capture", async () => {
  let captured;
  const router = new CaptureRouter({ capture: async (envelope) => { captured = envelope; return { diaryPath: "Daily/today.md" }; } }, () => ({}));
  await router.handle({ text: "/clip https://example.com/post", attachments: [] });
  assert.equal(captured.text, "https://example.com/post");
});
