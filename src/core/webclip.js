"use strict";

const { Readability } = require("@mozilla/readability");
const { parseHTML } = require("linkedom");
const { downloadRemoteFile, readLimitedBody, safeFetch } = require("./network");
const { localDateParts, safeFileName, shortHash, yamlString } = require("./util");

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

class WebClipper {
  constructor(writer, settings) {
    this.writer = writer;
    this.settings = settings;
  }

  async extract(url) {
    const { response, finalUrl } = await safeFetch(url, { accept: "text/html,application/xhtml+xml", timeoutMs: 30_000 });
    if (!response.ok) throw new Error(`Page returned HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("html") && !contentType.includes("xml")) throw new Error(`Unsupported page type: ${contentType || "unknown"}`);
    const html = (await readLimitedBody(response, 5 * 1024 * 1024)).toString("utf8");
    const { document } = parseHTML(html);
    prepareDocument(document, finalUrl);
    const article = new Readability(document.cloneNode(true), { charThreshold: 40 }).parse();
    const sourceHtml = article?.content || document.body?.innerHTML || "";
    const { document: articleDocument } = parseHTML(`<!doctype html><html><head></head><body>${sourceHtml}</body></html>`);
    prepareDocument(articleDocument, finalUrl);
    for (const image of articleDocument.querySelectorAll("img[src]")) {
      if (!isLikelyContentImage(image)) image.remove();
    }
    const images = [...articleDocument.querySelectorAll("img[src]")].map((image) => image.getAttribute("src")).filter(Boolean);
    const markdown = cleanMarkdown(nodeToMarkdown(articleDocument.body));
    return {
      url: finalUrl,
      title: article?.title || document.title || new URL(finalUrl).hostname,
      byline: article?.byline || "",
      excerpt: article?.excerpt || "",
      siteName: article?.siteName || new URL(finalUrl).hostname,
      markdown,
      images: [...new Set(images)],
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
    await this.writer.createText(notePath, `${frontmatter}# ${article.title}\n\n${markdown}${report}\n`);
    return { notePath, article, savedImages, imageFailures: failures };
  }
}

module.exports = { WebClipper, absoluteUrl, bestSrcset, cleanMarkdown, isLikelyContentImage, nodeToMarkdown, prepareDocument };
