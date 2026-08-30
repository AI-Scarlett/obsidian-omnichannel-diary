"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { extractPdf, fileNameFromHeaders } = require("../src/core/pdfclip");

function pdfjsLoader() {
  const textContent = { items: [
    { str: "Hello from", transform: [1, 0, 0, 12, 10, 700], width: 56, height: 12 },
    { str: "an online PDF", transform: [1, 0, 0, 12, 72, 700], width: 72, height: 12, hasEOL: true },
  ] };
  const document = {
    numPages: 1,
    getMetadata: async () => ({ info: {} }),
    getPage: async () => ({ getTextContent: async () => textContent, cleanup() {} }),
    destroy: async () => {},
  };
  return Promise.resolve({ getDocument: () => ({ promise: Promise.resolve(document) }) });
}

function buildPdf(text) {
  const stream = `BT\n/F1 18 Tf\n72 720 Td\n(${text.replace(/[\\()]/g, "\\$&")}) Tj\nET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test("online PDF text is split by page and the original PDF is retained", async () => {
  const pdf = Buffer.from("%PDF test payload");
  const article = await extractPdf(pdf, "https://example.com/files/report.pdf", "attachment; filename=report.pdf", { pdfjsLoader });
  assert.equal(article.title, "report");
  assert.equal(article.pageCount, 1);
  assert.equal(article.extractionMethod, "pdf-text");
  assert.match(article.markdown, /## Page 1/);
  assert.match(article.markdown, /Hello from an online PDF/);
  assert.equal(article.binaryFiles[0].fileName, "report.pdf");
  assert.deepEqual(article.binaryFiles[0].buffer, pdf);
});

test("the bundled PDF.js parser extracts text without a browser script loader", async () => {
  const article = await extractPdf(buildPdf("Marketplace safe PDF"), "https://example.com/safe.pdf");
  assert.equal(article.pageCount, 1);
  assert.match(article.markdown, /Marketplace safe PDF/);
});

test("PDF filenames support RFC 5987 headers", () => {
  assert.equal(fileNameFromHeaders("https://example.com/download", "attachment; filename*=UTF-8''weekly%20brief.pdf"), "weekly brief.pdf");
});
