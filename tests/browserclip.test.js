"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { WebSessionManager, commentSelectorsForService, isSupportedBrowserExecutablePath, looksLikeAuthentication, looksLikeBlockedPage, renderedPayloadExpression, selectorsForService } = require("../src/core/browserclip");
const { communityServiceForUrl, documentServiceForUrl, isLikelyPdfUrl, isProductHuntUrl, renderServiceForUrl } = require("../src/core/web-platforms");
const { WebClipper } = require("../src/core/webclip");

test("cloud documents and Product Hunt route to their rendered adapters", () => {
  assert.equal(documentServiceForUrl("https://example.feishu.cn/docx/abc"), "feishu");
  assert.equal(documentServiceForUrl("https://docs.qq.com/doc/abc"), "tencent");
  assert.equal(documentServiceForUrl("https://www.kdocs.cn/l/abc"), "wps");
  assert.equal(renderServiceForUrl("https://www.producthunt.com/posts/tool"), "producthunt");
  assert.equal(renderServiceForUrl("https://www.reddit.com/r/test/comments/abc/post"), "reddit");
  assert.equal(isProductHuntUrl("https://producthunt.com/posts/tool"), true);
  assert.equal(isLikelyPdfUrl("https://example.com/report.pdf?download=1"), true);
  assert.ok(selectorsForService("feishu").includes(".docx-content"));
  assert.equal(communityServiceForUrl("https://juejin.cn/post/123"), "juejin");
  assert.ok(commentSelectorsForService("github").includes(".timeline-comment"));
  assert.match(renderedPayloadExpression("github"), /commentCount/);
  const feishuExpression = renderedPayloadExpression("feishu");
  assert.match(feishuExpression, /data-omnichannel-virtual-document/);
  assert.match(feishuExpression, /virtualCapture/);
  assert.match(feishuExpression, /scrollTop/);
  assert.doesNotThrow(() => new Function(feishuExpression));
});

test("login pages are detected without treating normal private document text as login", () => {
  assert.equal(looksLikeAuthentication({ url: "https://passport.wps.cn/login", text: "登录 WPS" }, "wps"), true);
  assert.equal(looksLikeAuthentication({ url: "https://docs.qq.com/doc/abc", text: "这是腾讯文档正文。".repeat(300) }, "tencent"), false);
  assert.equal(looksLikeBlockedPage({ title: "403 Forbidden", text: "403 Forbidden" }), true);
  assert.equal(looksLikeBlockedPage({ title: "An article", text: "Useful public text".repeat(300) }), false);
});

test("browser sessions only accept supported absolute browser executables", () => {
  assert.equal(isSupportedBrowserExecutablePath("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"), true);
  assert.equal(isSupportedBrowserExecutablePath("/usr/bin/chromium"), true);
  assert.equal(isSupportedBrowserExecutablePath("relative/chrome"), false);
  assert.equal(isSupportedBrowserExecutablePath("/tmp/arbitrary-tool"), false);
});

test("WebClipper uses an injected persistent renderer for dynamic documents", async () => {
  const calls = [];
  const sessionManager = { extract: async (url, service) => {
    calls.push({ url, service });
    return {
      url, title: "项目方案", author: "Alice", description: "公开文档",
      html: `<main><h1>项目方案</h1><p>${"正文内容。".repeat(40)}</p><img src="https://cdn.example.com/diagram.png"></main>`,
      text: `项目方案\n${"正文内容。".repeat(40)}`,
    };
  } };
  const settings = {
    storage: { clippingFolder: "Clips", attachmentFolder: "Assets" },
    capture: { renderDynamicPages: true, browserExecutable: "", downloadWebImages: false, maxFileMb: 20 },
  };
  const clipper = new WebClipper({}, settings, { sessionManager });
  const article = await clipper.extract("https://docs.qq.com/doc/example");
  assert.deepEqual(calls, [{ url: "https://docs.qq.com/doc/example", service: "tencent" }]);
  assert.equal(article.extractionMethod, "tencent-rendered-document");
  assert.equal(article.extractionStatus, "complete");
  assert.match(article.markdown, /项目方案/);
  assert.deepEqual(article.images, ["https://cdn.example.com/diagram.png"]);
});

test("WebClipper never falls back to a short static page after virtual document capture is incomplete", async () => {
  const sessionManager = { extract: async () => {
    const error = new Error("Feishu virtualized document capture did not reach the end");
    error.code = "DOCUMENT_CAPTURE_INCOMPLETE";
    throw error;
  } };
  const settings = {
    storage: { clippingFolder: "Clips", attachmentFolder: "Assets" },
    capture: { renderDynamicPages: true, browserExecutable: "", downloadWebImages: false, maxFileMb: 20 },
  };
  const clipper = new WebClipper({}, settings, { sessionManager });
  await assert.rejects(
    clipper.extract("https://example.feishu.cn/docx/example"),
    (error) => error.code === "DOCUMENT_CAPTURE_INCOMPLETE",
  );
});

test("render requests sharing one browser profile are serialized", async () => {
  const manager = new WebSessionManager("/tmp/omnichannel-diary-unused-test-profile");
  let active = 0;
  let peak = 0;
  manager.extractUnlocked = async (url) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 8));
    active -= 1;
    return url;
  };
  const values = await Promise.all([manager.extract("one", "feishu"), manager.extract("two", "feishu")]);
  assert.deepEqual(values, ["one", "two"]);
  assert.equal(peak, 1);
});
