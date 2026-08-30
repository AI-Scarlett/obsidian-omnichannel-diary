"use strict";

const PDFParser = require("pdf2json");

function decodePdfText(value) {
  try { return decodeURIComponent(String(value || "").replace(/\+/g, "%20")); }
  catch (_) { return String(value || ""); }
}

function pageText(page) {
  const fragments = [];
  for (const item of page?.Texts || []) {
    const text = (item.R || []).map((run) => decodePdfText(run.T)).join("");
    if (text) fragments.push({ x: Number(item.x) || 0, y: Number(item.y) || 0, text });
  }
  fragments.sort((a, b) => Math.abs(a.y - b.y) < 0.18 ? a.x - b.x : a.y - b.y);
  const lines = [];
  for (const fragment of fragments) {
    const previous = lines.at(-1);
    if (!previous || Math.abs(previous.y - fragment.y) >= 0.18) lines.push({ y: fragment.y, text: fragment.text });
    else previous.text += fragment.text;
  }
  return lines.map((line) => line.text.trim()).join("\n").trim();
}

function parsePdfBuffer(buffer, parserFactory = () => new PDFParser(null, 1)) {
  return new Promise((resolve, reject) => {
    const parser = parserFactory();
    parser.once("pdfParser_dataError", (error) => reject(error?.parserError || error));
    parser.once("pdfParser_dataReady", resolve);
    parser.parseBuffer(Buffer.from(buffer));
  });
}

function fileNameFromHeaders(url, contentDisposition = "") {
  const encoded = String(contentDisposition).match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plain = String(contentDisposition).match(/filename="?([^";]+)"?/i)?.[1];
  let name = encoded ? decodePdfText(encoded) : plain;
  if (!name) {
    try { name = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).at(-1) || "document.pdf"); }
    catch (_) { name = "document.pdf"; }
  }
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`;
}

async function extractPdf(buffer, url, contentDisposition = "", options = {}) {
  const data = await parsePdfBuffer(buffer, options.parserFactory);
  const pages = data?.Pages || [];
  const parts = pages.map((page, index) => {
    const text = pageText(page);
    return text ? `## Page ${index + 1}\n\n${text}` : `## Page ${index + 1}\n\n_[No extractable text]_`;
  });
  const markdown = parts.join("\n\n").trim();
  const title = String(data?.Meta?.Title || data?.Meta?.Metadata?.Title || fileNameFromHeaders(url, contentDisposition).replace(/\.pdf$/i, "")).trim();
  const byline = String(data?.Meta?.Author || data?.Meta?.Metadata?.Author || "").trim();
  const contentChars = markdown.replace(/\s+/g, " ").length;
  return {
    url,
    title: title || "PDF document",
    byline,
    excerpt: markdown.replace(/^## Page \d+\s*/m, "").replace(/\s+/g, " ").slice(0, 240),
    siteName: "PDF",
    markdown,
    images: [],
    contentChars,
    extractionMethod: "pdf-text",
    extractionStatus: contentChars >= 80 ? "complete" : "partial",
    binaryFiles: [{ buffer: Buffer.from(buffer), mimeType: "application/pdf", fileName: fileNameFromHeaders(url, contentDisposition), label: "Original PDF" }],
    pageCount: pages.length,
  };
}

module.exports = { decodePdfText, extractPdf, fileNameFromHeaders, pageText, parsePdfBuffer };
