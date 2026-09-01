"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseHTML } = require("linkedom");
const {
  WebClipper, articleFromHtml, bestSrcset, cleanMarkdown, detectCommunityPage, escapeWebText,
  isLikelyContentImage, nodeToMarkdown, prepareDocument, selectArticle, wechatArticleIdentityUrl,
} = require("../src/core/webclip");

test("lazy images and relative links become absolute before extraction", () => {
  const { document } = parseHTML('<!doctype html><html><body><a href="/next">next</a><img data-src="/photo.jpg"><script>bad()</script></body></html>');
  prepareDocument(document, "https://example.com/posts/one");
  assert.equal(document.querySelector("a").getAttribute("href"), "https://example.com/next");
  assert.equal(document.querySelector("img").getAttribute("src"), "https://example.com/photo.jpg");
  assert.equal(document.querySelector("script"), null);
});

test("markdown conversion preserves headings, links, lists, and images", () => {
  const { document } = parseHTML('<!doctype html><html><body><h1>Title</h1><p>Hello <strong>world</strong>.</p><ul><li>One</li></ul><img src="https://example.com/a.png" alt="A"></body></html>');
  const markdown = cleanMarkdown(nodeToMarkdown(document.body));
  assert.match(markdown, /## Title/);
  assert.match(markdown, /Hello \*\*world\*\*/);
  assert.match(markdown, /- One/);
  assert.match(markdown, /!\[A\]\(<https:\/\/example.com\/a.png>\)/);
});

test("Feishu virtual document block types retain headings, lists, quotes, and dividers", () => {
  const { document } = parseHTML(`<!doctype html><html><body>
    <div data-block-type="heading2"><div>Section</div></div>
    <div data-block-type="bullet"><div>Bullet item</div></div>
    <div data-block-type="ordered"><div>2. Ordered item</div></div>
    <div data-block-type="quote_container"><div>Quoted text</div></div>
    <div data-block-type="divider"></div>
  </body></html>`);
  const markdown = cleanMarkdown(nodeToMarkdown(document.body));
  assert.match(markdown, /^### Section$/m);
  assert.match(markdown, /^- Bullet item$/m);
  assert.match(markdown, /^1\. Ordered item$/m);
  assert.match(markdown, /^> Quoted text$/m);
  assert.match(markdown, /^---$/m);
});

test("web text cannot become Obsidian embeds, comments, HTML, or executable fenced blocks", () => {
  const { document } = parseHTML('<!doctype html><html><body><p>![[Private note]] [[Wiki]] %% hidden %% &lt;iframe src="bad"&gt;</p><p>```dataviewjs</p><p>dv.pages()</p></body></html>');
  const markdown = cleanMarkdown(nodeToMarkdown(document.body));
  assert.doesNotMatch(markdown, /(^|[^\\])!\[\[/);
  assert.doesNotMatch(markdown, /(^|[^\\])\[\[/);
  assert.doesNotMatch(markdown, /(^|[^\\])%%/);
  assert.doesNotMatch(markdown, /<iframe/i);
  assert.doesNotMatch(markdown, /^```dataviewjs/m);
  assert.match(markdown, /\\!\\\[/);
  assert.match(escapeWebText("1. item"), /^1\\\. item$/);
});

test("code indentation, blank lines, and nested list depth survive Markdown cleanup", () => {
  const { document } = parseHTML('<!doctype html><html><body><pre>if ready:\n    run()\n\n    finish()</pre><ul><li>Parent<ul><li>Child<ol start="3"><li>Third</li></ol></li></ul></li></ul></body></html>');
  const markdown = cleanMarkdown(nodeToMarkdown(document.body));
  assert.match(markdown, /if ready:\n    run\(\)\n\n    finish\(\)/);
  assert.match(markdown, /^- Parent$/m);
  assert.match(markdown, /^  - Child$/m);
  assert.match(markdown, /^    3\. Third$/m);
});

test("srcset chooses the largest listed candidate", () => {
  assert.equal(bestSrcset("small.jpg 320w, large.jpg 1280w"), "large.jpg");
});

test("tiny decorative logos are excluded while article images remain", () => {
  const { document } = parseHTML('<!doctype html><html><body><img id="logo" src="https://cdn.example/60px-Commons-logo.svg.png"><img id="photo" src="https://cdn.example/1200px-landscape.jpg"></body></html>');
  assert.equal(isLikelyContentImage(document.querySelector("#logo")), false);
  assert.equal(isLikelyContentImage(document.querySelector("#photo")), true);
});

test("WeChat articles use js_content instead of script-heavy Readability input", () => {
  const filler = "这是微信公众号正文。".repeat(30);
  const { document } = parseHTML(`<!doctype html><html><head><meta name="author" content="作者甲"></head><body><script>${"noise ".repeat(2000)}</script><h1 id="activity-name">文章标题</h1><a id="js_name">测试公众号</a><div id="js_content"><p>${filler}</p><img data-src="/article.jpg"></div></body></html>`);
  prepareDocument(document, "https://mp.weixin.qq.com/s/example");
  const article = selectArticle(document, "https://mp.weixin.qq.com/s/example");
  assert.equal(article.extractionMethod, "wechat-article");
  assert.equal(article.title, "文章标题");
  assert.equal(article.byline, "作者甲");
  assert.equal(article.siteName, "测试公众号");
  assert.match(article.content, /这是微信公众号正文/);
  assert.match(article.content, /https:\/\/mp\.weixin\.qq\.com\/article\.jpg/);
});

test("WeChat extraction removes page chrome, normalizes titles, records publish time, and keeps a stable identity", () => {
  const html = `<!doctype html><html><head><link rel="canonical" href="https://mp.weixin.qq.com/s/short-id"></head><body>
    <script>var biz = "" || "MzA1234"; var mid = "123456789"; var idx = "2"; var createTime = 1700000000; var bait = "__biz=" + biz + "&mid=";</script>
    <h1 id="activity-name">First\n  title</h1><div id="js_content"><p>${"Article body. ".repeat(20)}</p><div class="rich_media_tool">Scan with WeChat</div></div>
  </body></html>`;
  const article = articleFromHtml(html, "https://mp.weixin.qq.com/s/short-id?scene=1");
  assert.equal(article.title, "First title");
  assert.equal(article.identityUrl, "https://mp.weixin.qq.com/s?__biz=MzA1234&mid=123456789&idx=2");
  assert.equal(article.publishedAt, "2023-11-14T22:13:20.000Z");
  assert.doesNotMatch(article.markdown, /Scan with WeChat/);
});

test("WeChat long URLs ignore volatile parameters and match short links when page identity is available", () => {
  const html = '<script>\nvar biz = "" || "MzB5678";\nvar mid = "987654321";\nvar idx = "1";\nvar bait = "__biz=" + biz + "&mid=";\n</script>';
  const longA = "https://mp.weixin.qq.com/s?__biz=MzB5678&mid=987654321&idx=1&chksm=aaa&scene=1";
  const longB = "https://mp.weixin.qq.com/s?scene=9&idx=1&mid=987654321&__biz=MzB5678&chksm=bbb";
  const short = "https://mp.weixin.qq.com/s/another-short-id";
  assert.equal(wechatArticleIdentityUrl(html, longA), wechatArticleIdentityUrl(html, longB));
  assert.equal(wechatArticleIdentityUrl(html, short), wechatArticleIdentityUrl(html, longA));
});

test("web image localization is concurrent, bounded, and reuses the stable clipping path", async () => {
  const settings = {
    storage: { clippingFolder: "Clippings", attachmentFolder: "Attachments" },
    capture: { downloadWebImages: true, maxFileMb: 20, maxWebImages: 3, maxWebImageTotalMb: 1, webClipBudgetSeconds: 75 },
  };
  let existingPath = "";
  let active = 0;
  let peak = 0;
  const writes = [];
  const writer = {
    findTextBySuffix: () => existingPath,
    saveBinary: async (folder, name) => `${folder}/${name}.png`,
    upsertText: async (path, content) => { existingPath = path; writes.push({ path, content }); },
  };
  const clipper = new WebClipper(writer, settings, {
    download: async (_url, options) => {
      assert.equal(options.timeoutMs <= 10_000, true);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 8));
      active -= 1;
      return { buffer: Buffer.alloc(400 * 1024), mimeType: "image/png", fileName: "image" };
    },
  });
  const article = {
    url: "https://example.com/post?utm_source=test",
    identityUrl: "https://example.com/post",
    title: "Example",
    siteName: "Example",
    byline: "",
    markdown: Array.from({ length: 5 }, (_, index) => `https://img.example/${index}.png`).join("\n"),
    images: Array.from({ length: 5 }, (_, index) => `https://img.example/${index}.png`),
    extractionMethod: "test",
    extractionStatus: "complete",
  };
  const first = await clipper.saveArticle(article, { timestamp: new Date("2026-08-31T00:00:00Z") });
  const second = await clipper.saveArticle(article, { timestamp: new Date("2026-09-01T00:00:00Z") });
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.notePath, first.notePath);
  assert.equal(first.savedImages, 2);
  assert.equal(first.imageFailures.length, 3);
  assert.equal(peak > 1 && peak <= 4, true);
  assert.equal(writes.length, 2);
});

test("unknown forum engines and generic comment markup receive a conversation fallback", () => {
  const html = `<!doctype html><html><head><meta name="generator" content="Flarum"></head><body><main><article><h1>Extensible forum</h1><p>${"Main technical discussion. ".repeat(12)}</p></article><div class="comment"><strong>Alice</strong><p>First useful reply with enough detail.</p></div><div class="comment"><strong>Bob</strong><p>Second useful reply with another perspective.</p></div></main></body></html>`;
  assert.equal(detectCommunityPage(html, "https://forum.example.org/d/123"), true);
  const article = articleFromHtml(html, "https://forum.example.org/d/123");
  assert.equal(article.commentCount, 2);
  assert.match(article.extractionMethod, /with-comments/);
  assert.match(article.markdown, /First useful reply/);
});
