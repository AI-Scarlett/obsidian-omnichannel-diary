"use strict";

const { Readability } = require("@mozilla/readability");
const { parseHTML } = require("linkedom");
const { extractCommunityPost } = require("./communityclip");
const { downloadRemoteFile, readLimitedBody, safeFetch } = require("./network");
const { localDateParts, safeFileName, shortHash, yamlString } = require("./util");
const { extractPdf } = require("./pdfclip");
const { extractRedditPost, parseRedditUrl } = require("./redditclip");
const { COMMUNITY_SERVICES, communityServiceForUrl, documentServiceForUrl, isLikelyPdfUrl, renderServiceForUrl } = require("./web-platforms");
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

const GENERIC_COMMENT_SELECTORS = [
  "[itemprop='comment']", "[data-testid*='comment' i]", ".topic-post", ".comment-item", ".feedbackItem", ".CommentItem", ".comment", ".reply", ".answer",
];

function genericCommentNodes(document) {
  for (const selector of GENERIC_COMMENT_SELECTORS) {
    let nodes = [];
    try { nodes = [...document.querySelectorAll(selector)].filter((node) => normalizedText(node).length >= 12); } catch (_) {}
    if (nodes.length) return nodes.slice(0, 300);
  }
  return [];
}

function detectCommunityPage(html, finalUrl) {
  const { document } = parseHTML(html);
  const generator = metaContent(document, 'meta[name="generator"]').toLowerCase();
  if (/discourse|forem|question2answer|flarum|nodebb|vanilla forums|xenforo/.test(generator)) return true;
  let pathname = "";
  try { pathname = new URL(finalUrl).pathname; } catch (_) {}
  if (/\/(?:t|topic|discussion|questions?)\/[^/]*\d+/i.test(pathname)) return true;
  return genericCommentNodes(document).length > 0;
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

function articleFromHtml(html, finalUrl, overrides = {}) {
  const { document } = parseHTML(html);
  prepareDocument(document, finalUrl);
  const article = overrides.content !== undefined ? overrides : { ...selectArticle(document, finalUrl), ...overrides };
  let sourceHtml = article.content !== undefined ? article.content : document.body?.innerHTML || "";
  let commentCount = Number(article.commentCount) || 0;
  if (overrides.content === undefined) {
    const articleText = normalizedText(parseHTML(`<body>${sourceHtml}</body>`).document.body);
    const comments = genericCommentNodes(document).filter((node) => {
      const sample = normalizedText(node).slice(0, 100);
      return sample && !articleText.includes(sample);
    });
    if (comments.length) {
      sourceHtml += `<section class="community-comments"><h2>Comments (${comments.length})</h2>${comments.map((node, index) => `<article><h3>Comment ${index + 1}</h3>${node.outerHTML}</article>`).join("")}</section>`;
      commentCount = comments.length;
      article.extractionMethod = `${article.extractionMethod || "readability"}-with-comments`;
    }
  }
  const { document: articleDocument } = parseHTML(`<!doctype html><html><head></head><body>${sourceHtml}</body></html>`);
  prepareDocument(articleDocument, finalUrl);
  for (const image of articleDocument.querySelectorAll("img[src]")) {
    if (!isLikelyContentImage(image)) image.remove();
  }
  const images = [...articleDocument.querySelectorAll("img[src]")]
    .map((image) => image.getAttribute("src"))
    .filter((value) => /^(?:https?:|data:)/i.test(value || ""));
  const converted = cleanMarkdown(nodeToMarkdown(articleDocument.body));
  const fallbackText = cleanMarkdown(overrides.plainText || "");
  const markdown = converted.length >= Math.min(120, fallbackText.length) ? converted : fallbackText;
  const contentChars = (fallbackText || normalizedText(articleDocument.body)).length;
  const hostname = new URL(finalUrl).hostname;
  return {
    url: finalUrl,
    title: article.title || document.title || hostname,
    byline: article.byline || "",
    excerpt: article.excerpt || fallbackText.slice(0, 240),
    siteName: article.siteName || hostname,
    markdown,
    images: [...new Set(images)],
    contentChars,
    extractionMethod: article.extractionMethod || "rendered-page",
    extractionStatus: contentChars >= 120 ? "complete" : "partial",
    commentCount,
  };
}

class WebClipper {
  constructor(writer, settings, options = {}) {
    this.writer = writer;
    this.settings = settings;
    this.sessionManager = options.sessionManager;
  }

  async extract(url) {
    const xStatus = await extractXStatus(url);
    if (xStatus) return xStatus;
    let communityError;
    if (parseRedditUrl(url)) {
      try {
        const reddit = await extractRedditPost(url);
        if (reddit) return reddit;
      } catch (error) { communityError = error; }
    } else {
      try {
        const data = await extractCommunityPost(url);
        if (data) {
          const article = articleFromHtml(data.contentHtml, data.url || url, {
            title: data.title,
            byline: data.byline,
            excerpt: data.excerpt,
            siteName: data.siteName,
            content: data.contentHtml,
            extractionMethod: data.extractionMethod,
          });
          return { ...article, commentCount: data.commentCount || 0, extractionStatus: data.extractionStatus || article.extractionStatus };
        }
      } catch (error) { communityError = error; }
    }
    const renderService = this.settings.capture.renderDynamicPages !== false ? renderServiceForUrl(url) : null;
    let renderError;
    if (renderService && this.sessionManager) {
      try {
        const rendered = await this.sessionManager.extract(url, renderService, {
          browserExecutable: this.settings.capture.browserExecutable,
        });
        const article = articleFromHtml(rendered.html, rendered.url, {
          title: rendered.title,
          byline: rendered.author,
          excerpt: rendered.description,
          siteName: COMMUNITY_SERVICES[renderService]?.name || new URL(rendered.url).hostname,
          content: rendered.html,
          plainText: rendered.text,
          extractionMethod: documentServiceForUrl(rendered.url) ? `${renderService}-rendered-document` : `${renderService}-rendered-community-comments`,
        });
        if (article.extractionStatus === "complete") return { ...article, commentCount: Number(rendered.commentCount) || 0 };
        renderError = new Error(`${COMMUNITY_SERVICES[renderService]?.name || renderService} rendered content was too short to save safely`);
      } catch (error) {
        if (error?.code === "DOCUMENT_LOGIN_REQUIRED") throw error;
        renderError = error;
      }
    }
    if (parseRedditUrl(url) && communityError) throw renderError || communityError;
    const { response, finalUrl } = await safeFetch(url, { accept: "text/html,application/xhtml+xml,application/pdf", timeoutMs: 30_000 });
    if (!response.ok) throw new Error(`Page returned HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/pdf") || (isLikelyPdfUrl(finalUrl) && !contentType.includes("html"))) {
      const buffer = await readLimitedBody(response, this.settings.capture.maxFileMb * 1024 * 1024);
      return extractPdf(buffer, finalUrl, response.headers.get("content-disposition") || "");
    }
    if (!contentType.includes("html") && !contentType.includes("xml")) throw new Error(`Unsupported page type: ${contentType || "unknown"}`);
    const html = (await readLimitedBody(response, 5 * 1024 * 1024)).toString("utf8");
    if (!renderService && this.settings.capture.renderDynamicPages !== false && this.sessionManager && detectCommunityPage(html, finalUrl)) {
      try {
        const rendered = await this.sessionManager.extract(finalUrl, "community-generic", {
          browserExecutable: this.settings.capture.browserExecutable,
        });
        const renderedArticle = articleFromHtml(rendered.html, rendered.url, {
          title: rendered.title,
          byline: rendered.author,
          excerpt: rendered.description,
          siteName: new URL(rendered.url).hostname,
          content: rendered.html,
          plainText: rendered.text,
          extractionMethod: "generic-rendered-community-comments",
        });
        if (renderedArticle.extractionStatus === "complete") return { ...renderedArticle, commentCount: Number(rendered.commentCount) || 0 };
      } catch (error) {
        renderError = renderError || error;
      }
    }
    const article = articleFromHtml(html, finalUrl);
    if ((renderError || communityError) && article.extractionStatus === "partial") {
      article.renderWarning = renderError?.message || communityError?.message || String(renderError || communityError);
    }
    return article;
  }

  async save(url, source = {}) {
    const article = await this.extract(url);
    return this.saveArticle(article, source);
  }

  async saveArticle(article, source = {}) {
    const date = localDateParts(source.timestamp || new Date());
    const stem = safeFileName(article.title, new URL(article.url).hostname);
    const notePath = `${this.settings.storage.clippingFolder}/${date.day}-${stem}-${shortHash(article.url)}.md`;
    let markdown = article.markdown || article.excerpt || article.url;
    const failures = [];
    const fileFailures = [];
    let savedImages = 0;
    let savedFiles = 0;
    const assetFolder = `${this.settings.storage.attachmentFolder}/Web/${date.day}/${stem}-${shortHash(article.url)}`;
    for (const [index, file] of (article.binaryFiles || []).entries()) {
      try {
        const localPath = await this.writer.saveBinary(assetFolder, file.fileName || `source-${index + 1}`, file.buffer, file.mimeType);
        markdown = `[${file.label || file.fileName || "Source file"}](${encodeURI(localPath)})\n\n${markdown}`;
        savedFiles += 1;
      } catch (error) {
        fileFailures.push(`${file.fileName || `source-${index + 1}`}: ${error?.message || error}`);
      }
    }
    if (this.settings.capture.downloadWebImages) {
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
      `extraction_method: ${yamlString(article.extractionMethod || "unknown")}`,
      "---",
      "",
    ].join("\n");
    const warningParts = [];
    if (failures.length) warningParts.push(`${failures.length} 张图片未能本地保存，正文中保留远程地址`);
    if (fileFailures.length) warningParts.push(`${fileFailures.length} 个原文件未能本地保存`);
    const report = warningParts.length ? `\n\n> [!warning] ${warningParts.join("；")}。` : "";
    const content = `${frontmatter}# ${article.title}\n\n${markdown}${report}\n`;
    if (typeof this.writer.upsertText === "function") await this.writer.upsertText(notePath, content);
    else await this.writer.createText(notePath, content);
    return { notePath, article, savedImages, savedFiles, imageFailures: failures, fileFailures };
  }
}

module.exports = { WebClipper, absoluteUrl, articleFromHtml, bestSrcset, cleanMarkdown, detectCommunityPage, genericCommentNodes, isLikelyContentImage, nodeToMarkdown, normalizedText, prepareDocument, selectArticle };
