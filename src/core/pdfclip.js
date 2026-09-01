"use strict";

let pdfJsPromise;

function ensurePdfTextRuntime() {
  if (typeof globalThis.DOMMatrix === "undefined") {
    // PDF.js instantiates one DOMMatrix while loading its optional canvas
    // renderer. Text extraction does not use that renderer, but Node runtimes
    // without a native canvas binding still need the constructor to exist.
    globalThis.DOMMatrix = class DOMMatrix {};
  }
}

function loadPdfJs() {
  if (!pdfJsPromise) {
    ensurePdfTextRuntime();
    pdfJsPromise = import("pdfjs-dist/legacy/build/pdf.mjs");
  }
  return pdfJsPromise;
}

function decodePdfText(value) {
  try { return decodeURIComponent(String(value || "").replace(/\+/g, "%20")); }
  catch (_) { return String(value || ""); }
}

function pageText(textContent) {
  const lines = [];
  for (const item of textContent?.items || []) {
    const text = String(item?.str || "");
    if (!text) continue;
    const x = Number(item?.transform?.[4]) || 0;
    const y = Number(item?.transform?.[5]) || 0;
    const height = Math.max(1, Math.abs(Number(item?.height) || Number(item?.transform?.[3]) || 0));
    const previous = lines.at(-1);
    const startsNewLine = !previous || previous.hasEOL || Math.abs(previous.y - y) > Math.max(2, height * 0.45);
    if (startsNewLine) {
      lines.push({ y, endX: x + (Number(item?.width) || 0), text, hasEOL: Boolean(item?.hasEOL) });
      continue;
    }
    const gap = x - previous.endX;
    const separator = gap > Math.max(1.5, height * 0.12) && !/\s$/.test(previous.text) && !/^\s/.test(text) ? " " : "";
    previous.text += `${separator}${text}`;
    previous.endX = Math.max(previous.endX, x + (Number(item?.width) || 0));
    previous.hasEOL = Boolean(item?.hasEOL);
  }
  return lines.map((line) => line.text.trim()).join("\n").trim();
}

async function parsePdfBuffer(buffer, pdfjsLoader = loadPdfJs) {
  const pdfjs = await pdfjsLoader();
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    useSystemFonts: true,
  });
  const document = await loadingTask.promise;
  try {
    const metadata = await document.getMetadata().catch(() => ({}));
    const pages = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      pages.push(await page.getTextContent());
      page.cleanup();
    }
    const info = metadata?.info || {};
    const xmp = metadata?.metadata;
    return {
      Meta: {
        Title: info.Title || xmp?.get?.("dc:title") || "",
        Author: info.Author || xmp?.get?.("dc:creator") || "",
      },
      Pages: pages,
    };
  } finally {
    await document.destroy();
  }
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
  const data = await parsePdfBuffer(buffer, options.pdfjsLoader);
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

module.exports = { decodePdfText, ensurePdfTextRuntime, extractPdf, fileNameFromHeaders, loadPdfJs, pageText, parsePdfBuffer };
