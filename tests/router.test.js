"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { CaptureRouter, HELP_TEXT, formatCaptureReceipt, formatHelpText } = require("../src/core/router");
const { CHANNEL_IDS } = require("../src/core/settings");

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

test("help and status follow the user's English language choice", async () => {
  const replies = [];
  const router = new CaptureRouter({ capture: async () => assert.fail("help must not capture") }, () => ({ telegram: { state: "connected" } }), {
    getLocale: () => "en",
    getStorage: () => ({ diaryFolder: "Notes/Daily" }),
    replyRetryDelays: [0],
  });
  await router.handle({ text: "help", reply: async (text) => replies.push(text) });
  await router.handle({ text: "/status", reply: async (text) => replies.push(text) });
  assert.equal(replies[0], formatHelpText("en", { diaryFolder: "Notes/Daily" }));
  assert.match(replies[0], /quick-capture Agent/);
  assert.match(replies[0], /Send “help” anytime/);
  assert.match(replies[1], /1 channel online/);
  assert.doesNotMatch(replies.join("\n"), /[\u4e00-\u9fff]/);
});

test("clip command passes only the URL to diary capture", async () => {
  let captured;
  const router = new CaptureRouter({ capture: async (envelope) => { captured = envelope; return { diaryPath: "Daily/today.md" }; } }, () => ({}));
  await router.handle({ text: "/clip https://example.com/post", attachments: [] });
  assert.equal(captured.text, "https://example.com/post");
});

test("capture receipts use the same friendly format across all nine channels", async () => {
  const replies = [];
  const diary = {
    capture: async (envelope) => ({
      diaryPath: "日记/2026-08-30.md",
      diaryFolder: "日记",
      clippingFolder: "全渠道剪藏",
      messageKey: `${envelope.channel}:1`,
      clips: [{
        notePath: "全渠道剪藏/article.md",
        article: { title: "月入30万美元，这位英国老兵把最“土”的网站做到了月访问791万", extractionStatus: "complete" },
        savedImages: 7,
        imageFailures: [],
      }],
      clipFailures: [],
      attachmentFailures: [],
    }),
    queueReceipt: async () => {},
    completeReceipt: async () => {},
  };
  const router = new CaptureRouter(diary, () => ({}), { replyRetryDelays: [0] });
  for (const channel of CHANNEL_IDS) {
    await router.handle({ channel, text: "https://example.com", reply: async (text) => replies.push(text) });
  }
  assert.equal(new Set(replies).size, 1);
  assert.equal(replies.length, 9);
  assert.equal(replies[0], [
    "🔖 《月入30万美元，这位英国老兵把最“土”的网站做到了月访问791万》已提取正文和 7 张图片并保存到「全渠道剪藏」",
    "",
    "嗨~ 我是你的随手记 Agent ✍️ 想记什么直接发给我，说错了可以直接在 Obsidian 里修改，随时发「帮助」看全部用法。",
  ].join("\n"));
});

test("English capture receipts are friendly and identical across all nine channels", async () => {
  const replies = [];
  const diary = {
    capture: async (envelope) => ({
      diaryPath: "Daily/2026-08-30.md",
      diaryFolder: "Daily",
      clippingFolder: "Clippings",
      messageKey: `${envelope.channel}:english`,
      clips: [{
        notePath: "Clippings/article.md",
        article: { title: "A practical guide to local-first capture", extractionStatus: "complete" },
        savedImages: 1,
        imageFailures: [],
      }],
      clipFailures: [],
      attachmentFailures: [],
    }),
    queueReceipt: async () => {},
    completeReceipt: async () => {},
  };
  const router = new CaptureRouter(diary, () => ({}), { getLocale: () => "en", replyRetryDelays: [0] });
  for (const channel of CHANNEL_IDS) {
    await router.handle({ channel, text: "https://example.com", reply: async (text) => replies.push(text) });
  }
  assert.equal(new Set(replies).size, 1);
  assert.equal(replies.length, 9);
  assert.match(replies[0], /^🔖 “A practical guide to local-first capture” was saved to “Clippings” with the full text and 1 image\./);
  assert.match(replies[0], /Hi~ I'm your quick-capture Agent/);
  assert.doesNotMatch(replies[0], /[\u4e00-\u9fff]/);
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
    clips: [{ article: { title: "测试网页", extractionStatus: "partial" }, savedImages: 2, imageFailures: ["image"] }],
    clipFailures: [],
    attachmentFailures: [],
  });
  assert.match(text, /^⚠️ 《测试网页》正文提取不完整/);
  assert.match(text, /2 张图片/);
  assert.match(text, /另有 1 张图片保存失败/);
  assert.match(text, /随手记 Agent/);
});

test("community receipts report captured comment threads in both languages", () => {
  const clip = { article: { title: "技术讨论", extractionStatus: "complete", commentCount: 26 }, savedImages: 3, imageFailures: [] };
  assert.match(formatCaptureReceipt({ diaryPath: "日记/today.md", clips: [clip] }), /正文、26 条评论和 3 张图片/);
  assert.match(formatCaptureReceipt({ diaryPath: "Daily/today.md", clips: [clip] }, "en"), /full text, 26 comments, and 3 images/);
});

test("reused clippings are reported consistently in Chinese and English", () => {
  const result = {
    diaryPath: "日记/2026-08-31.md",
    clippingFolder: "全渠道剪藏",
    clips: [{
      reused: true,
      notePath: "全渠道剪藏/reused.md",
      savedImages: 0,
      imageFailures: [],
      fileFailures: [],
      article: { title: "Existing page", extractionStatus: "complete" },
    }],
  };
  assert.match(formatCaptureReceipt(result, "zh-CN"), /之前已经保存，已复用/);
  assert.match(formatCaptureReceipt(result, "en"), /was already saved\. Reused/);
});

test("PDF receipts distinguish a saved original from an original-file failure", () => {
  const saved = formatCaptureReceipt({
    diaryPath: "日记/today.md", clips: [{ article: { title: "在线报告", extractionStatus: "complete" }, savedImages: 0, savedFiles: 1, imageFailures: [], fileFailures: [] }],
  });
  assert.match(saved, /并保留 1 个原文件/);
  const failed = formatCaptureReceipt({
    diaryPath: "日记/today.md", clips: [{ article: { title: "在线报告", extractionStatus: "complete" }, savedImages: 0, savedFiles: 0, imageFailures: [], fileFailures: ["pdf"] }],
  });
  assert.match(failed, /^⚠️/);
  assert.match(failed, /1 个原文件保存失败/);
});

test("chat PDF receipts report extracted pages and preserved attachments", () => {
  const text = formatCaptureReceipt({
    diaryPath: "日记/today.md",
    diaryFolder: "日记",
    clippingFolder: "全渠道剪藏",
    clips: [{ article: { title: "季度报告", extractionStatus: "complete", extractionMethod: "pdf-text", pageCount: 12 }, savedImages: 0, savedFiles: 0, imageFailures: [], fileFailures: [] }],
    savedAttachments: 1,
    attachmentFailures: [],
    attachmentExtractionFailures: [],
  });
  assert.match(text, /^🔖 《季度报告》已提取 12 页 PDF 正文并保存到「全渠道剪藏」/);
  assert.match(text, /📎 已保存 1 个附件到今天的「日记」/);
});

test("code-platform bookmarks use the same bilingual receipt format", () => {
  const result = {
    diaryPath: "日记/today.md",
    diaryFolder: "日记",
    codePlatformFolder: "代码平台收藏",
    codeLinks: [{ name: "GitHub", repository: "openai/openai-node", notePath: "代码平台收藏/GitHub/openai-openai-node.md" }],
    clips: [], clipFailures: [], codeLinkFailures: [], attachmentFailures: [],
  };
  const zh = formatCaptureReceipt(result);
  assert.match(zh, /^🔗 已将 GitHub 的「openai\/openai-node」分类保存到「代码平台收藏」/);
  assert.doesNotMatch(zh, /^✍️/);
  const en = formatCaptureReceipt({ ...result, diaryPath: "Daily/today.md", diaryFolder: "Daily", codePlatformFolder: "Code Links" }, "en");
  assert.match(en, /^🔗 Saved “openai\/openai-node” from GitHub to “Code Links”\./);
  assert.doesNotMatch(en, /[\u4e00-\u9fff]/);
});

test("code-platform filing failures keep the original URL in the daily note receipt", () => {
  const zh = formatCaptureReceipt({ diaryPath: "日记/today.md", clips: [], codeLinks: [], clipFailures: [], codeLinkFailures: ["failed"], attachmentFailures: [] });
  assert.match(zh, /^⚠️ 1 个代码平台地址未能分类保存/);
  const en = formatCaptureReceipt({ diaryPath: "Daily/today.md", clips: [], codeLinks: [], clipFailures: [], codeLinkFailures: ["failed"], attachmentFailures: [] }, "en");
  assert.match(en, /^⚠️ 1 code-platform link could not be filed/);
});
