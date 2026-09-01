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

const WECHAT_NOISE_SELECTORS = [
  "#js_pc_qr_code", "#js_article_bottom_bar", "#js_bottom_ad_area", "#js_sponsor_ad_area",
  ".rich_media_tool", ".rich_media_area_extra", ".weui-dialog", ".weui-mask", ".qr_code_pc",
  "[aria-label='二维码']", "[aria-label='QR code']",
];

const TRACKING_QUERY_NAMES = new Set([
  "fbclid", "gclid", "mc_cid", "mc_eid", "ref_src", "spm", "source", "igshid",
]);

const WECHAT_TRANSIENT_QUERY_NAMES = new Set([
  "chksm", "scene", "nwr_flag", "subscene", "clicktime", "enterid", "ascene", "devicetype",
  "version", "lang", "nettype", "exportkey", "pass_ticket", "wx_header", "from",
]);

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
  let hostname = "";
  try { hostname = new URL(url).hostname.toLowerCase(); } catch (_) {}
  if (hostname === "mp.weixin.qq.com") {
    for (const selector of WECHAT_NOISE_SELECTORS) {
      for (const element of document.querySelectorAll(selector)) element.remove();
    }
  }
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

function escapeWebText(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([`*_{}[\]()#+\-.!|~])/g, "\\$1")
    .replace(/%/g, "\\%");
}

function markdownDestination(value) {
  return String(value || "").replace(/>/g, "%3E").replace(/\s/g, (character) => encodeURIComponent(character));
}

function inlineCode(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "``";
  const runs = [...text.matchAll(/`+/g)].map((match) => match[0].length);
  const fence = "`".repeat(Math.max(1, ...runs, 0) + 1);
  const padding = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${padding}${text}${padding}${fence}`;
}

function fencedCode(value) {
  const text = String(value || "").replace(/\r\n?/g, "\n").replace(/^\n+|\n+$/g, "");
  const runs = [...text.matchAll(/`{3,}/g)].map((match) => match[0].length);
  const fence = "`".repeat(Math.max(3, ...runs, 2) + 1);
  return `\n\n${fence}\n${text}\n${fence}\n\n`;
}

function directListItems(node) {
  return [...node.childNodes].filter((child) => child.nodeType === 1 && String(child.localName || "").toLowerCase() === "li");
}

function listToMarkdown(node, context = {}) {
  const depth = Math.max(0, Number(context.listDepth) || 0);
  const ordered = String(node.localName || "").toLowerCase() === "ol";
  const start = Math.max(1, Number(node.getAttribute?.("start")) || 1);
  const rows = [];
  directListItems(node).forEach((item, index) => {
    const nested = [];
    const body = [...item.childNodes].map((child) => {
      const tag = child.nodeType === 1 ? String(child.localName || "").toLowerCase() : "";
      if (tag === "ul" || tag === "ol") {
        nested.push(child);
        return "";
      }
      return nodeToMarkdown(child, { ...context, listDepth: depth });
    }).join("").replace(/\s*\n+\s*/g, " ").trim();
    const marker = ordered ? `${start + index}.` : "-";
    rows.push(`${"  ".repeat(depth)}${marker} ${body}`.trimEnd());
    for (const child of nested) {
      rows.push(nodeToMarkdown(child, { ...context, listDepth: depth + 1 }).replace(/^\n|\n$/g, ""));
    }
  });
  return `\n${rows.join("\n")}\n`;
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

function nodeToMarkdown(node, context = {}) {
  if (!node) return "";
  if (node.nodeType === 3) return escapeWebText(String(node.nodeValue || "").replace(/\s+/g, " "));
  if (node.nodeType !== 1) return "";
  const tag = String(node.localName || "").toLowerCase();
  if (["script", "style", "noscript", "svg"].includes(tag)) return "";
  if (tag === "pre") return fencedCode(node.textContent || "");
  if (tag === "ul" || tag === "ol") return listToMarkdown(node, context);
  const content = [...node.childNodes].map((child) => nodeToMarkdown(child, context)).join("");
  if (tag === "br") return "\n";
  if (tag === "p" || tag === "div" || tag === "section" || tag === "article") return `\n\n${content.trim()}\n\n`;
  if (/^h[1-6]$/.test(tag)) return `\n\n${"#".repeat(Number(tag[1]) + 1)} ${content.trim()}\n\n`;
  if (tag === "strong" || tag === "b") return `**${content.trim()}**`;
  if (tag === "em" || tag === "i") return `*${content.trim()}*`;
  if (tag === "code") return inlineCode(node.textContent || "");
  if (tag === "blockquote") return `\n\n${content.trim().split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
  if (tag === "li") return content;
  if (tag === "a") {
    const href = node.getAttribute("href") || "";
    return href ? `[${content.trim() || escapeWebText(href)}](<${markdownDestination(href)}>)` : content;
  }
  if (tag === "img") {
    const src = node.getAttribute("src") || "";
    const alt = escapeWebText(node.getAttribute("alt") || "");
    return src ? `\n\n![${alt}](<${markdownDestination(src)}>)\n\n` : "";
  }
  return content;
}

function cleanMarkdown(value) {
  const output = [];
  let fenceCharacter = "";
  let fenceLength = 0;
  let previousBlank = false;
  for (const originalLine of String(value || "").replace(/\r\n?/g, "\n").split("\n")) {
    const line = fenceCharacter ? originalLine : originalLine.replace(/[ \t]+$/g, "");
    const opening = !fenceCharacter && line.match(/^\s*(`{3,}|~{3,})(?:\s|$)/);
    if (opening) {
      fenceCharacter = opening[1][0];
      fenceLength = opening[1].length;
      output.push(line);
      previousBlank = false;
      continue;
    }
    if (fenceCharacter) {
      output.push(line);
      const closing = line.match(/^\s*(`+|~+)\s*$/);
      if (closing && closing[1][0] === fenceCharacter && closing[1].length >= fenceLength) {
        fenceCharacter = "";
        fenceLength = 0;
      }
      continue;
    }
    if (!line.trim()) {
      if (!previousBlank && output.length) output.push("");
      previousBlank = true;
    } else {
      output.push(line);
      previousBlank = false;
    }
  }
  return output.join("\n").trim();
}

function normalizedText(node) {
  return String(node?.textContent || "").replace(/\s+/g, " ").trim();
}

function metaContent(document, selector) {
  return String(document.querySelector(selector)?.getAttribute("content") || "").trim();
}

function compactTitle(value, fallback = "Untitled web page") {
  const title = String(value || "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return (title || fallback).slice(0, 300);
}

function normalizedIdentityUrl(value, extraIgnored = new Set()) {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    for (const name of [...parsed.searchParams.keys()]) {
      if (/^utm_/i.test(name) || TRACKING_QUERY_NAMES.has(name.toLowerCase()) || extraIgnored.has(name.toLowerCase())) parsed.searchParams.delete(name);
    }
    const ordered = [...parsed.searchParams.entries()].sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
    parsed.search = "";
    for (const [name, item] of ordered) parsed.searchParams.append(name, item);
    return parsed.toString();
  } catch (_) {
    return String(value || "");
  }
}

function declaredWechatValue(html, name, validator) {
  const pattern = new RegExp(`(?:^|[;{}>\\n])\\s*var\\s+${name}\\s*=\\s*([^;\\n]+)`, "gim");
  for (const declaration of String(html || "").matchAll(pattern)) {
    for (const literal of declaration[1].matchAll(/(["'])(.*?)\1/g)) {
      const candidate = String(literal[2] || "").trim();
      if (validator(candidate)) return candidate;
    }
  }
  return "";
}

function validWechatBiz(value) {
  return /^[A-Za-z0-9+/_-]{4,128}={0,2}$/.test(String(value || ""));
}

function validWechatNumber(value) {
  return /^\d{1,30}$/.test(String(value || ""));
}

function wechatArticleIdentityUrl(html, sourceUrl, canonicalUrl = "") {
  const candidates = [];
  for (const value of [sourceUrl, canonicalUrl]) {
    try {
      const parsed = new URL(value);
      if (parsed.hostname.toLowerCase() === "mp.weixin.qq.com") candidates.push(parsed);
    } catch (_) {}
  }
  for (const parsed of candidates) {
    const biz = parsed.searchParams.get("__biz") || "";
    const mid = parsed.searchParams.get("mid") || "";
    const idx = parsed.searchParams.get("idx") || "";
    if (validWechatBiz(biz) && validWechatNumber(mid) && validWechatNumber(idx)) {
      const stable = new URL("https://mp.weixin.qq.com/s");
      stable.searchParams.set("__biz", biz);
      stable.searchParams.set("mid", mid);
      stable.searchParams.set("idx", idx);
      return stable.toString();
    }
  }
  const biz = declaredWechatValue(html, "biz", validWechatBiz);
  const mid = declaredWechatValue(html, "mid", validWechatNumber);
  const idx = declaredWechatValue(html, "idx", validWechatNumber);
  if (biz && mid && idx) {
    const stable = new URL("https://mp.weixin.qq.com/s");
    stable.searchParams.set("__biz", biz);
    stable.searchParams.set("mid", mid);
    stable.searchParams.set("idx", idx);
    return stable.toString();
  }
  for (const parsed of candidates) {
    const shortId = parsed.pathname.match(/^\/s\/([^/]+)\/?$/)?.[1];
    if (shortId) return `https://mp.weixin.qq.com/s/${encodeURIComponent(decodeURIComponent(shortId))}`;
  }
  return normalizedIdentityUrl(canonicalUrl || sourceUrl, WECHAT_TRANSIENT_QUERY_NAMES);
}

function publishedWechatTime(html) {
  for (const name of ["createTime", "create_time", "publish_time", "ct"]) {
    const quoted = declaredWechatValue(html, name, (candidate) => /^\d{10,13}$/.test(candidate));
    const numericPattern = new RegExp(`(?:^|[;{}>\\n])\\s*var\\s+${name}\\s*=\\s*(\\d{10,13})(?:\\D|$)`, "im");
    const value = quoted || numericPattern.exec(String(html || ""))?.[1] || "";
    if (!value) continue;
    const number = Number(value);
    const date = new Date(value.length === 13 ? number : number * 1000);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return "";
}

function canonicalUrlFromDocument(document, finalUrl) {
  const raw = document.querySelector('link[rel="canonical"]')?.getAttribute("href")
    || metaContent(document, 'meta[property="og:url"]');
  return absoluteUrl(raw, finalUrl) || finalUrl;
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
      title: compactTitle(title, hostname),
      byline,
      excerpt: metaContent(document, 'meta[property="og:description"]') || plainText.slice(0, 240),
      siteName,
      content: wechatContent.innerHTML,
      extractionMethod: "wechat-article",
    };
  }
  const article = new Readability(document.cloneNode(true), { charThreshold: 40 }).parse();
  return {
    title: compactTitle(article?.title || document.title, hostname),
    byline: article?.byline || "",
    excerpt: article?.excerpt || "",
    siteName: article?.siteName || hostname,
    content: article?.content || document.body?.innerHTML || "",
    extractionMethod: article?.content ? "readability" : "document-body",
  };
}

function articleFromHtml(html, finalUrl, overrides = {}) {
  const rawHtml = String(html || "");
  const { document } = parseHTML(html);
  const canonicalUrl = canonicalUrlFromDocument(document, finalUrl);
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
    canonicalUrl,
    identityUrl: hostname.toLowerCase() === "mp.weixin.qq.com"
      ? wechatArticleIdentityUrl(rawHtml, finalUrl, canonicalUrl)
      : normalizedIdentityUrl(canonicalUrl || finalUrl),
    title: compactTitle(article.title || document.title, hostname),
    byline: article.byline || "",
    excerpt: article.excerpt || fallbackText.slice(0, 240),
    siteName: article.siteName || hostname,
    markdown,
    images: [...new Set(images)],
    contentChars,
    extractionMethod: article.extractionMethod || "rendered-page",
    extractionStatus: contentChars >= 120 ? "complete" : "partial",
    commentCount,
    publishedAt: hostname.toLowerCase() === "mp.weixin.qq.com" ? publishedWechatTime(rawHtml) : "",
  };
}

function deadlinePromise(promise, deadline, message) {
  const remaining = Number(deadline) - Date.now();
  if (!Number.isFinite(remaining) || remaining > 2_147_000_000) return promise;
  if (remaining <= 0) return Promise.reject(new Error(message));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), remaining);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

async function mapWithConcurrency(items, concurrency, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  const run = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, run));
  return output;
}

class WebClipper {
  constructor(writer, settings, options = {}) {
    this.writer = writer;
    this.settings = settings;
    this.sessionManager = options.sessionManager;
    this.download = options.download || downloadRemoteFile;
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
    const budgetMs = Math.max(10, Number(this.settings.capture.webClipBudgetSeconds) || 75) * 1000;
    const deadline = Number(source.deadline) || Date.now() + budgetMs;
    const article = await deadlinePromise(this.extract(url), deadline, "Web clipping exceeded its time budget");
    return this.saveArticle(article, source, { deadline });
  }

  async saveArticle(article, source = {}, options = {}) {
    const date = localDateParts(source.timestamp || new Date());
    const title = compactTitle(article.title, new URL(article.url).hostname);
    const stem = safeFileName(title, new URL(article.url).hostname);
    const identityUrl = article.identityUrl || article.canonicalUrl || normalizedIdentityUrl(article.url);
    const suffix = `-${shortHash(identityUrl)}.md`;
    const existingPath = typeof this.writer.findTextBySuffix === "function"
      ? this.writer.findTextBySuffix(this.settings.storage.clippingFolder, suffix)
      : "";
    const notePath = existingPath || `${this.settings.storage.clippingFolder}/${date.day}-${stem}${suffix}`;
    const reused = Boolean(existingPath);
    let markdown = article.markdown || article.excerpt || article.url;
    const failures = [];
    const fileFailures = [];
    let savedImages = 0;
    let savedFiles = 0;
    const assetFolder = `${this.settings.storage.attachmentFolder}/Web/${date.day}/${stem}-${shortHash(identityUrl)}`;
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
      const maxImages = Math.max(1, Number(this.settings.capture.maxWebImages) || 30);
      const allImages = [...new Set(article.images || [])];
      const selectedImages = allImages.slice(0, maxImages);
      const maxTotalBytes = Math.max(1, Number(this.settings.capture.maxWebImageTotalMb) || 50) * 1024 * 1024;
      const deadline = Number(options.deadline) || Date.now() + (Math.max(10, Number(this.settings.capture.webClipBudgetSeconds) || 75) * 1000);
      let reservedBytes = 0;
      for (const imageUrl of allImages.slice(maxImages)) failures.push(`${imageUrl}: skipped because the article image-count limit is ${maxImages}`);
      const localized = await mapWithConcurrency(selectedImages, 4, async (imageUrl, index) => {
        try {
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw new Error("skipped because the article time budget was exhausted");
          const downloaded = await this.download(imageUrl, {
            referrer: article.url,
            maxBytes: Math.min((Number(this.settings.capture.maxFileMb) || 20) * 1024 * 1024, maxTotalBytes),
            timeoutMs: Math.min(10_000, remaining),
            requestAttempts: 2,
            shouldRetry: (error) => error?.code === "ECONNRESET",
            httpAttempts: 1,
            fileName: `image-${String(index + 1).padStart(2, "0")}`,
          });
          if (!downloaded.mimeType.startsWith("image/")) throw new Error(`not an image (${downloaded.mimeType})`);
          if (reservedBytes + downloaded.buffer.length > maxTotalBytes) throw new Error(`skipped because the article image budget is ${this.settings.capture.maxWebImageTotalMb || 50} MB`);
          reservedBytes += downloaded.buffer.length;
          try {
            const localPath = await this.writer.saveBinary(assetFolder, downloaded.fileName, downloaded.buffer, downloaded.mimeType);
            return { imageUrl, localPath };
          } catch (error) {
            reservedBytes -= downloaded.buffer.length;
            throw error;
          }
        } catch (error) {
          return { imageUrl, error: error?.message || String(error) };
        }
      });
      for (const result of localized) {
        if (result.localPath) {
          markdown = markdown.split(result.imageUrl).join(encodeURI(result.localPath));
          savedImages += 1;
        } else failures.push(`${result.imageUrl}: ${result.error}`);
      }
    }
    const frontmatter = [
      "---",
      `title: ${yamlString(title)}`,
      `source: ${yamlString(article.url)}`,
      `canonical: ${yamlString(article.canonicalUrl || article.url)}`,
      `identity: ${yamlString(identityUrl)}`,
      `site: ${yamlString(article.siteName)}`,
      `author: ${yamlString(article.byline)}`,
      `published_at: ${yamlString(article.publishedAt || "")}`,
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
    const content = `${frontmatter}# ${escapeWebText(title)}\n\n${markdown}${report}\n`;
    if (typeof this.writer.upsertText === "function") await this.writer.upsertText(notePath, content);
    else await this.writer.createText(notePath, content);
    return { notePath, article: { ...article, title, identityUrl }, reused, savedImages, savedFiles, imageFailures: failures, fileFailures };
  }
}

module.exports = {
  WebClipper, absoluteUrl, articleFromHtml, bestSrcset, canonicalUrlFromDocument, cleanMarkdown, compactTitle,
  declaredWechatValue, detectCommunityPage, escapeWebText, genericCommentNodes, isLikelyContentImage,
  mapWithConcurrency, nodeToMarkdown, normalizedIdentityUrl, normalizedText, prepareDocument, publishedWechatTime,
  selectArticle, wechatArticleIdentityUrl,
};
