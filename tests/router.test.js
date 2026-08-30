"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { CaptureRouter, HELP_TEXT, formatCaptureReceipt } = require("../src/core/router");

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

test("capture receipts are identical across WeChat and WhatsApp", async () => {
  const replies = [];
  const diary = {
    capture: async (envelope) => ({
      diaryPath: "日记/2026-08-30.md",
      messageKey: `${envelope.channel}:1`,
      clips: [{ article: { extractionStatus: "complete" }, imageFailures: [] }],
      clipFailures: [],
      attachmentFailures: [],
    }),
    queueReceipt: async () => {},
    completeReceipt: async () => {},
  };
  const router = new CaptureRouter(diary, () => ({}), { replyRetryDelays: [0] });
  for (const channel of ["wechat", "whatsapp"]) {
    await router.handle({ channel, text: "https://example.com", reply: async (text) => replies.push(text) });
  }
  assert.equal(replies[0], replies[1]);
  assert.equal(replies[0], "✅ 已保存\n日记：日记/2026-08-30.md\n网页剪藏：1 篇，正文已提取");
});

test("reply retries and clears the durable receipt only after delivery", async () => {
  let attempts = 0;
  const events = [];
  const diary = {
    capture: async () => ({ diaryPath: "日记/today.md", messageKey: "wechat:retry", clips: [], clipFailures: [], attachmentFailures: [] }),
    queueReceipt: async (id, text) => events.push(["queued", id, text]),
    completeReceipt: async (id) => events.push(["completed", id]),
  };
  const router = new CaptureRouter(diary, () => ({}), { replyRetryDelays: [0, 0, 0] });
  await router.handle({ text: "hello", reply: async () => { attempts += 1; if (attempts < 3) throw new Error("temporary"); } });
  assert.equal(attempts, 3);
  assert.equal(events[0][0], "queued");
  assert.deepEqual(events.at(-1), ["completed", "wechat:retry"]);
});

test("a replayed duplicate sends its pending receipt without saving twice", async () => {
  const replies = [];
  const completed = [];
  const diary = {
    capture: async () => ({ ignored: "duplicate", messageKey: "wechat:pending", pendingReceipt: "✅ 已保存\n日记：日记/today.md" }),
    completeReceipt: async (id) => completed.push(id),
  };
  const router = new CaptureRouter(diary, () => ({}), { replyRetryDelays: [0] });
  await router.handle({ text: "hello", reply: async (text) => replies.push(text) });
  assert.deepEqual(replies, ["✅ 已保存\n日记：日记/today.md"]);
  assert.deepEqual(completed, ["wechat:pending"]);
});

test("partial extraction produces a warning instead of a false success", () => {
  const text = formatCaptureReceipt({
    diaryPath: "日记/today.md",
    clips: [{ article: { extractionStatus: "partial" }, imageFailures: ["image"] }],
    clipFailures: [],
    attachmentFailures: [],
  });
  assert.match(text, /^⚠️ 已部分保存/);
  assert.match(text, /正文不完整/);
  assert.match(text, /图片失败：1 张/);
});
