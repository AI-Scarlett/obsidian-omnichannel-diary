"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isXiaohongshuUrl,
  parseInitialState,
  replaceBareUndefined,
  xiaohongshuDataFromHtml,
} = require("../src/core/xhsclip");

const SOURCE_URL = "https://www.xiaohongshu.com/explore/note123?xsec_token=temporary";

function sampleHtml() {
  const state = `{"global":{"prompt":undefined},"note":{"currentNoteId":"note123","noteDetailMap":{"note123":{"note":{"noteId":"note123","title":"A useful note","desc":"First line\\nSecond line with enough useful text to save.","time":1788253336000,"user":{"nickname":"Alice"},"imageList":[{"urlPre":"http:\\u002F\\u002Fsns-webpic-qc.xhscdn.com\\u002Fpreview-one","urlDefault":"http:\\u002F\\u002Fsns-webpic-qc.xhscdn.com\\u002Fdefault-one","infoList":[{"imageScene":"WB_DFT","url":"http:\\u002F\\u002Fsns-webpic-qc.xhscdn.com\\u002Fbest-one"}]},{"urlDefault":"https:\\u002F\\u002Fsns-webpic-hw.xhscdn.com\\u002Fsecond"},{"urlDefault":"https:\\u002F\\u002Ftracker.example.com\\u002Fpixel"}]}}}}}`;
  return `<!doctype html><html><body><script>window.__INITIAL_STATE__=${state}</script></body></html>`;
}

test("Xiaohongshu URLs include full and short share links", () => {
  assert.equal(isXiaohongshuUrl(SOURCE_URL), true);
  assert.equal(isXiaohongshuUrl("https://xhslink.com/a/AbCd12"), true);
  assert.equal(isXiaohongshuUrl("https://xhslink.cn/o/2Mh8nwXF6Xx"), true);
  assert.equal(isXiaohongshuUrl("https://example.com/explore/note123"), false);
});

test("initial-state JSON replaces only bare undefined values", () => {
  assert.equal(replaceBareUndefined('{"text":"undefined","value":undefined}'), '{"text":"undefined","value":null}');
  assert.equal(parseInitialState(sampleHtml()).global.prompt, null);
});

test("Xiaohongshu initial state yields full-size localizable images and stable identity", () => {
  const data = xiaohongshuDataFromHtml(sampleHtml(), SOURCE_URL);
  assert.equal(data.title, "A useful note");
  assert.equal(data.byline, "Alice");
  assert.equal(data.identityUrl, "https://www.xiaohongshu.com/explore/note123");
  assert.equal(data.extractionMethod, "xiaohongshu-initial-state");
  assert.deepEqual(data.images, [
    "https://sns-webpic-qc.xhscdn.com/best-one",
    "https://sns-webpic-hw.xhscdn.com/second",
  ]);
  assert.match(data.contentHtml, /小红书图片 1/);
  assert.match(data.contentHtml, /First line<br>Second line/);
});
