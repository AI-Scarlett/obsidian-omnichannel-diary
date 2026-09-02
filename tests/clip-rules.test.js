"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { DiaryService } = require("../src/core/diary");
const { WebClipper } = require("../src/core/webclip");
const {
  classifyClipFamily,
  defaultClipRules,
  isClipFamilyEnabled,
  normalizeClipRules,
  resolveClipFolder,
} = require("../src/core/clip-rules");
const { normalizeSettings } = require("../src/core/settings");

test("URLs are classified by source family before they are saved", () => {
  assert.equal(classifyClipFamily("https://example.com/blog/hello"), "articles");
  assert.equal(classifyClipFamily("https://x.com/openai/status/1234567890123456789"), "social");
  assert.equal(classifyClipFamily("https://mp.weixin.qq.com/s/abc"), "social");
  assert.equal(classifyClipFamily("https://www.xiaohongshu.com/explore/64f"), "social");
  assert.equal(classifyClipFamily("https://news.ycombinator.com/item?id=1"), "community");
  assert.equal(classifyClipFamily("https://community.obsidian.md/t/topic/123"), "community");
  assert.equal(classifyClipFamily("https://docs.qq.com/doc/abc"), "documents");
  assert.equal(classifyClipFamily("https://files.example.com/report.pdf"), "pdfs");
  assert.equal(classifyClipFamily("attachment://wechat/1/report.pdf", { extractionMethod: "pdf-text" }), "pdfs");
});

test("disabled clipping types stay in the daily note and skip extraction", async () => {
  const value = normalizeSettings({
    schemaVersion: 1,
    storage: { diaryFolder: "日记", clippingFolder: "剪藏", attachmentFolder: "附件" },
    capture: { autoClipLinks: true, clipRules: { articles: { enabled: false } } },
  });
  const writes = [];
  const diary = new DiaryService({
    append: async (path, content) => { writes.push({ path, content }); return { path }; },
  }, () => value, async () => {}, {
    webClipperFactory: () => ({ save: async () => { throw new Error("must not clip"); } }),
  });
  const result = await diary.capture({
    channel: "wechat",
    id: "disabled-article",
    timestamp: new Date("2026-09-02T02:00:00Z"),
    text: "看这篇 https://example.com/blog/hello",
    attachments: [],
  });
  assert.equal(result.clips.length, 0);
  assert.equal(result.clipFailures.length, 1);
  assert.match(result.clipFailures[0], /该剪藏类型已关闭/);
  assert.match(writes[0].content, /https:\/\/example.com\/blog\/hello/);
});

test("enabled clipping types write into typed subfolders under the clipping root", async () => {
  const settings = {
    storage: { clippingFolder: "Clippings", attachmentFolder: "Attachments" },
    capture: { downloadWebImages: false, clipRules: defaultClipRules() },
  };
  const writes = [];
  const writer = {
    findTextBySuffix: () => "",
    upsertText: async (path, content) => { writes.push({ path, content }); },
  };
  const clipper = new WebClipper(writer, settings, { download: async () => { throw new Error("no images"); } });
  const saved = await clipper.saveArticle({
    url: "https://example.com/post",
    identityUrl: "https://example.com/post",
    title: "Example",
    siteName: "Example",
    byline: "",
    markdown: "Body text that is long enough to keep.",
    images: [],
    extractionMethod: "readability",
    extractionStatus: "complete",
  }, { timestamp: new Date("2026-09-02T00:00:00Z") });
  assert.match(saved.notePath, /^Clippings\/Articles\//);
  assert.equal(isClipFamilyEnabled(settings, "articles"), true);
  assert.equal(resolveClipFolder(settings, "social"), "Clippings/Social");
  assert.equal(normalizeClipRules({ articles: { folder: " /News\\\\Blogs/ " } }).articles.folder, "News/Blogs");
});
