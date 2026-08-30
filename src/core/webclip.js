"use strict";

const { Readability } = require("@mozilla/readability");
const { parseHTML } = require("linkedom");
const { downloadRemoteFile, readLimitedBody, safeFetch } = require("./network");
const { localDateParts, safeFileName, shortHash, yamlString } = require("./util");
const { extractXStatus } = require("./xclip");

function absoluteUrl(value, baseUrl) {
  if (!value) return "";
  try { return new URL(value, baseUrl).toString(); } catch (_) { return ""; }
}

function bestSrcset(value) {
  const entries = String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
  if (!entries.length) return "";
  return entries[entries.length - 1].split(/\s+/)[0];
}

function prepareDocument(document, url) {
  for (const element of document.querySelectorAll("script,style,noscript,template")) element.remove();
  for (const image of document.querySelectorAll("img")) {
    const candidate = image.getAttribute("data-src") || image.getAttribute("data-original")
      || image.getAttribute("data-lazy-src") || bestSrcset(image.getAttribute("data-srcset") || image.getAttribute("srcset"))
      || image.getAttribute("src");
    const resolved = absoluteUrl(candidate, url);
    if (resolved) image.setAttribute("src", resolved);
  }
  for (const anchor of document.querySelectorAll("a[href]")) {
    const resolved = absoluteUrl(anchor.getAttribute("href"), url);
    if (resolved) anchor.setAttribute("href", resolved);
  }
}

function isLikelyContentImage(image) {
  const src = image.getAttribute("src") || "";
  const width = Number(image.getAttribute("width") || 0);
  const height = Number(image.getAttribute("height") || 0);
  if (width > 0 && height > 0 && width <= 80 && height <= 80) return false;
  if (/\b(spacer|tracking[-_]?pixel|transparent\.gif)\b/i.test(src)) return false;
  const thumbnail = src.match(/\/(\d{1,3})px-[^/?]*(?:logo|icon|avatar|emoji)/i);
  if (thumbnail && Number(thumbnail[1]) <= 96) return false;
  return true;
}

function nodeToMarkdown(node) {
  if (!node) return "";
  if (node.nodeType === 3) return String(node.nodeValue || "").replace(/\s+/g, " ");
  if (node.nodeType !== 1) return "";
  const tag = String(node.localName || "").toLowerCase();
  const content = [...node.childNodes].map(nodeToMarkdown).join("");
  if (["script", "style", "noscript", "svg"].includes(tag)) return "";
  if (tag === "br") return "\n";
  if (tag === "p" || tag === "div" || tag === "section" || tag === "article") return `\n\n${content.trim()}\n\n`;
  if (/^h[1-6]$/.test(tag)) return `\n\n${"#".repeat(Number(tag[1]) + 1)} ${content.trim()}\n\n`;
  if (tag === "strong" || tag === "b") return `**${content.trim()}**`;
  if (tag === "em" || tag === "i") return `*${content.trim()}*`;
  if (tag === "code") return `\`${content.replace(/`/g, "\\`")}\``;
  if (tag === "pre") return `\n\n\`\`\`\n${node.textContent || ""}\n\`\`\`\n\n`;
  if (tag === "blockquote") return `\n\n${content.trim().split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
  if (tag === "li") return `\n- ${content.trim()}`;
  if (tag === "a") {
    const href = node.getAttribute("href") || "";
    return href ? `[${content.trim() || href}](${href})` : content;
  }
  if (tag === "img") {
    const src = node.getAttribute("src") || "";
    const alt = String(node.getAttribute("alt") || "").replace(/[\[\]]/g, "");
    return src ? `\n\n![${alt}](${src})\n\n` : "";
  }
  return content;
}

function cleanMarkdown(value) {
  return String(value || "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function normalizedText(node) {
  return String(node?.textContent || "").replace(/\s+/g, " ").trim();
}

function metaContent(document, selector) {
  return String(document.querySelector(selector)?.getAttribute("content") || "").trim();
}

function selectArticle(document, finalUrl) {
  const hostname = new URL(finalUrl).hostname.toLowerCase();
  const wechatContent = hostname === "mp.weixin.qq.com" ? document.querySelector("#js_content") : null;
  if (wechatContent && normalizedText(wechatContent).length >= 40) {
    const title = normalizedText(document.querySelector("#activity-name"))
      || metaContent(document, 'meta[property="og:title"]')
      || document.title
      || hostname;
    const byline = normalizedText(document.querySelector("#js_author_name"))
      || metaContent(document, 'meta[name="author"]');
    const siteName = normalizedText(document.querySelector("#js_name")) || "微信公众号";
    const plainText = normalizedText(wechatContent);
    return {
      title,
      byline,
      excerpt: metaContent(document, 'meta[property="og:description"]') || plainText.slice(0, 240),
      siteName,
      content: wechatContent.innerHTML,
      extractionMethod: "wechat-article",
    };
  }
  const article = new Readability(document.cloneNode(true), { charThreshold: 40 }).parse();
  return {
    title: article?.title || document.title || hostname,
    byline: article?.byline || "",
    excerpt: article?.excerpt || "",
    siteName: article?.siteName || hostname,
    content: article?.content || document.body?.innerHTML || "",
    extractionMethod: article?.content ? "readability" : "document-body",
  };
}

class WebClipper {
  constructor(writer, settings) {
    this.writer = writer;
    this.settings = settings;
  }

  async extract(url) {
    const xStatus = await extractXStatus(url);
    if (xStatus) return xStatus;
    const { response, finalUrl } = await safeFetch(url, { accept: "text/html,application/xhtml+xml", timeoutMs: 30_000 });
    if (!response.ok) throw new Error(`Page returned HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("html") && !contentType.includes("xml")) throw new Error(`Unsupported page type: ${contentType || "unknown"}`);
    const html = (await readLimitedBody(response, 5 * 1024 * 1024)).toString("utf8");
    const { document } = parseHTML(html);
    prepareDocument(document, finalUrl);
    const article = selectArticle(document, finalUrl);
    const sourceHtml = article.content;
    const { document: articleDocument } = parseHTML(`<!doctype html><html><head></head><body>${sourceHtml}</body></html>`);
    prepareDocument(articleDocument, finalUrl);
    for (const image of articleDocument.querySelectorAll("img[src]")) {
      if (!isLikelyContentImage(image)) image.remove();
    }
    const images = [...articleDocument.querySelectorAll("img[src]")].map((image) => image.getAttribute("src")).filter(Boolean);
    const markdown = cleanMarkdown(nodeToMarkdown(articleDocument.body));
    const contentChars = normalizedText(articleDocument.body).length;
    return {
      url: finalUrl,
      title: article.title,
      byline: article.byline,
      excerpt: article.excerpt,
      siteName: article.siteName,
      markdown,
      images: [...new Set(images)],
      contentChars,
      extractionMethod: article.extractionMethod,
      extractionStatus: contentChars >= 120 ? "complete" : "partial",
    };
  }

  async save(url, source = {}) {
    const article = await this.extract(url);
    const date = localDateParts(source.timestamp || new Date());
    const stem = safeFileName(article.title, new URL(article.url).hostname);
    const notePath = `${this.settings.storage.clippingFolder}/${date.day}-${stem}-${shortHash(article.url)}.md`;
    let markdown = article.markdown || article.excerpt || article.url;
    const failures = [];
    let savedImages = 0;
    if (this.settings.capture.downloadWebImages) {
      const assetFolder = `${this.settings.storage.attachmentFolder}/Web/${date.day}/${stem}-${shortHash(article.url)}`;
      for (const [index, imageUrl] of article.images.slice(0, 60).entries()) {
        try {
          const downloaded = await downloadRemoteFile(imageUrl, {
            referrer: article.url,
            maxBytes: this.settings.capture.maxFileMb * 1024 * 1024,
            fileName: `image-${String(index + 1).padStart(2, "0")}`,
          });
          if (!downloaded.mimeType.startsWith("image/")) throw new Error(`not an image (${downloaded.mimeType})`);
          const localPath = await this.writer.saveBinary(assetFolder, downloaded.fileName, downloaded.buffer, downloaded.mimeType);
          markdown = markdown.split(imageUrl).join(encodeURI(localPath));
          savedImages += 1;
        } catch (error) {
          failures.push(`${imageUrl}: ${error?.message || error}`);
        }
      }
    }
    const frontmatter = [
      "---",
      `title: ${yamlString(article.title)}`,
      `source: ${yamlString(article.url)}`,
      `site: ${yamlString(article.siteName)}`,
      `author: ${yamlString(article.byline)}`,
      `clipped_at: ${yamlString(date.iso)}`,
      `channel: ${yamlString(source.channel || "manual")}`,
      "---",
      "",
    ].join("\n");
    const report = failures.length ? `\n\n> [!warning] ${failures.length} 张图片未能本地保存，正文中保留远程地址。` : "";
    const content = `${frontmatter}# ${article.title}\n\n${markdown}${report}\n`;
    if (typeof this.writer.upsertText === "function") await this.writer.upsertText(notePath, content);
    else await this.writer.createText(notePath, content);
    return { notePath, article, savedImages, imageFailures: failures };
  }
}

module.exports = { WebClipper, absoluteUrl, bestSrcset, cleanMarkdown, isLikelyContentImage, nodeToMarkdown, normalizedText, prepareDocument, selectArticle };
