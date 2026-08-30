"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseHTML } = require("linkedom");
const { bestSrcset, cleanMarkdown, isLikelyContentImage, nodeToMarkdown, prepareDocument, selectArticle } = require("../src/core/webclip");

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
  assert.match(markdown, /!\[A\]\(https:\/\/example.com\/a.png\)/);
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
