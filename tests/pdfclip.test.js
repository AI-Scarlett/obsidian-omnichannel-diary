"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { extractPdf, fileNameFromHeaders } = require("../src/core/pdfclip");

function parserFactory() {
  const parser = new EventEmitter();
  parser.parseBuffer = () => queueMicrotask(() => parser.emit("pdfParser_dataReady", {
    Meta: {},
    Pages: [{ Texts: [
      { x: 1, y: 1, R: [{ T: "Hello%20from" }] },
      { x: 3, y: 1, R: [{ T: "%20an%20online%20PDF" }] },
    ] }],
  }));
  return parser;
}

test("online PDF text is split by page and the original PDF is retained", async () => {
  const pdf = Buffer.from("%PDF test payload");
  const article = await extractPdf(pdf, "https://example.com/files/report.pdf", "attachment; filename=report.pdf", { parserFactory });
  assert.equal(article.title, "report");
  assert.equal(article.pageCount, 1);
  assert.equal(article.extractionMethod, "pdf-text");
  assert.match(article.markdown, /## Page 1/);
  assert.match(article.markdown, /Hello from an online PDF/);
  assert.equal(article.binaryFiles[0].fileName, "report.pdf");
  assert.deepEqual(article.binaryFiles[0].buffer, pdf);
});

test("PDF filenames support RFC 5987 headers", () => {
  assert.equal(fileNameFromHeaders("https://example.com/download", "attachment; filename*=UTF-8''weekly%20brief.pdf"), "weekly brief.pdf");
});
