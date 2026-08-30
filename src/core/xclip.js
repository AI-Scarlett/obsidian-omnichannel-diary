"use strict";

const { parseHTML } = require("linkedom");
const { readLimitedBody, safeFetch } = require("./network");

// This is X's public web-client bearer value, not a user credential.
const X_WEB_BEARER = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
const X_ARTICLE_QUERY_ID = "T7RzLvKJSQQNUA1eQrCQDw";

function parseXStatusUrl(input) {
  let url;
  try { url = new URL(input); } catch (_) { return null; }
  const hostname = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^mobile\./, "");
  if (!["x.com", "twitter.com"].includes(hostname)) return null;
  const match = url.pathname.match(/^\/([^/]+)\/status\/(\d{10,25})(?:\/|$)/i);
  if (!match) return null;
  return {
    username: match[1],
    id: match[2],
    url: `https://x.com/${match[1]}/status/${match[2]}`,
  };
}

async function jsonRequest(url, options = {}, maxBytes = 8 * 1024 * 1024) {
  const { response } = await safeFetch(url, { ...options, accept: "application/json" });
  if (!response.ok) throw new Error(`X returned HTTP ${response.status}`);
  const body = (await readLimitedBody(response, maxBytes)).toString("utf8");
  try { return JSON.parse(body); } catch (_) { throw new Error("X returned invalid JSON"); }
}

function unwrapTweetResult(payload) {
  const value = payload?.data?.tweet_result_by_rest_id?.result;
  return value?.tweet || value || null;
}

function mediaImageUrl(media) {
  const info = media?.media_info || media;
  return info?.original_img_url || info?.preview_image?.original_img_url || "";
}

function articleImages(article) {
  const values = [];
  const cover = mediaImageUrl(article?.cover_media_results?.result);
  if (cover) values.push(cover);
  for (const media of article?.media_entities || []) {
    const value = mediaImageUrl(media);
    if (value) values.push(value);
  }
  return [...new Set(values)];
}

function entityMapByKey(contentState) {
  return new Map((contentState?.entity_map || []).map((item) => [String(item.key), item.value || {}]));
}

function mediaById(article) {
  return new Map((article?.media_entities || []).map((item) => [String(item.media_id), item]));
}

function renderAtomicBlock(block, entities, media) {
  const values = [];
  for (const range of block.entity_ranges || []) {
    const entity = entities.get(String(range.key));
    if (!entity) continue;
    const data = entity.data || {};
    if (entity.type === "DIVIDER") values.push("---");
    if (entity.type === "MARKDOWN" && data.markdown) values.push(String(data.markdown).trim());
    if (entity.type === "MEDIA") {
      for (const item of data.media_items || []) {
        const source = media.get(String(item.media_id));
        const url = mediaImageUrl(source);
        if (url) values.push(`![${String(source?.media_info?.alt_text || data.caption || "X media").replace(/[\[\]]/g, "")}](${url})`);
      }
    }
  }
  return values.join("\n\n");
}

function renderTextBlock(block) {
  const text = String(block.text || "").trim();
  if (!text) return "";
  const type = String(block.type || "unstyled");
  if (type === "header-one") return `## ${text}`;
  if (type === "header-two") return `### ${text}`;
  if (type === "header-three") return `#### ${text}`;
  if (type === "unordered-list-item") return `- ${text}`;
  if (type === "ordered-list-item") return `1. ${text}`;
  if (type === "blockquote") return text.split("\n").map((line) => `> ${line}`).join("\n");
  if (type === "code-block") return `\`\`\`\n${text}\n\`\`\``;
  return text;
}

function draftBlocksToMarkdown(contentState, article = {}) {
  const entities = entityMapByKey(contentState);
  const media = mediaById(article);
  const values = [];
  for (const block of contentState?.blocks || []) {
    const value = block.type === "atomic" ? renderAtomicBlock(block, entities, media) : renderTextBlock(block);
    if (value) values.push(value);
  }
  return values.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

function articleFromPayload(payload, status) {
  const tweet = unwrapTweetResult(payload);
  const article = tweet?.article?.article_results?.result;
  if (!article?.content_state?.blocks?.length) return null;
  const author = tweet?.core?.user_results?.result?.core || {};
  const images = articleImages(article);
  let markdown = draftBlocksToMarkdown(article.content_state, article);
  const cover = mediaImageUrl(article?.cover_media_results?.result);
  if (cover && !markdown.includes(cover)) markdown = `![X Article cover](${cover})\n\n${markdown}`;
  const contentChars = String(article.plain_text || markdown).replace(/\s+/g, " ").trim().length;
  return {
    url: status.url,
    title: article.title || `${author.name || status.username} on X`,
    byline: author.name ? `${author.name}${author.screen_name ? ` (@${author.screen_name})` : ""}` : `@${status.username}`,
    excerpt: article.preview_text || String(article.plain_text || "").slice(0, 240),
    siteName: "X",
    markdown,
    images,
    contentChars,
    extractionMethod: "x-article",
    extractionStatus: contentChars >= 120 ? "complete" : "partial",
  };
}

async function fetchXArticle(status) {
  const authorization = `Bearer ${X_WEB_BEARER}`;
  const activation = await jsonRequest("https://api.x.com/1.1/guest/activate.json", {
    method: "POST",
    headers: { authorization },
    requestAttempts: 3,
  }, 1024 * 1024);
  if (!activation.guest_token) throw new Error("X guest session was not issued");
  const variables = encodeURIComponent(JSON.stringify({ restId: status.id }));
  const endpoint = `https://api.x.com/graphql/${X_ARTICLE_QUERY_ID}/ArticleByTweetId?variables=${variables}`;
  const payload = await jsonRequest(endpoint, {
    headers: { authorization, "x-guest-token": activation.guest_token },
    requestAttempts: 3,
  });
  return articleFromPayload(payload, status);
}

async function fetchXEmbed(status) {
  const endpoint = `https://publish.x.com/oembed?omit_script=true&dnt=true&url=${encodeURIComponent(status.url)}`;
  const data = await jsonRequest(endpoint, { requestAttempts: 3 }, 1024 * 1024);
  const { document } = parseHTML(data.html || "");
  const paragraph = document.querySelector("blockquote p");
  const text = String(paragraph?.textContent || "").replace(/\s+/g, " ").trim();
  const links = [...(paragraph?.querySelectorAll("a[href]") || [])].map((anchor) => anchor.getAttribute("href")).filter(Boolean);
  const markdown = text || links.join("\n") || status.url;
  const substantive = markdown.replace(/https?:\/\/\S+/g, "").trim();
  return {
    url: data.url || status.url,
    title: substantive.slice(0, 100) || `${data.author_name || `@${status.username}`} on X`,
    byline: data.author_name || `@${status.username}`,
    excerpt: substantive.slice(0, 240),
    siteName: "X",
    markdown,
    images: [],
    contentChars: substantive.length,
    extractionMethod: "x-oembed",
    extractionStatus: substantive ? "complete" : "partial",
  };
}

async function extractXStatus(input) {
  const status = parseXStatusUrl(input);
  if (!status) return null;
  let articleError;
  try {
    const article = await fetchXArticle(status);
    if (article) return article;
  } catch (error) { articleError = error; }
  try { return await fetchXEmbed(status); }
  catch (embedError) {
    const detail = [articleError?.message, embedError?.message].filter(Boolean).join("; ");
    throw new Error(`X content extraction failed${detail ? `: ${detail}` : ""}`);
  }
}

module.exports = { articleFromPayload, articleImages, draftBlocksToMarkdown, extractXStatus, fetchXArticle, fetchXEmbed, mediaImageUrl, parseXStatusUrl, unwrapTweetResult };
