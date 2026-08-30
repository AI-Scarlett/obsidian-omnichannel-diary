"use strict";

const { readLimitedBody, safeFetch } = require("./network");

function parseRedditUrl(value) {
  let url;
  try { url = new URL(value); } catch (_) { return null; }
  const host = url.hostname.toLowerCase();
  if (host === "redd.it" || host.endsWith(".redd.it")) {
    const id = url.pathname.split("/").filter(Boolean)[0];
    return id ? { id, url: `https://www.reddit.com/comments/${id}/` } : null;
  }
  if (!(host === "reddit.com" || host.endsWith(".reddit.com"))) return null;
  const match = url.pathname.match(/\/comments\/([a-z0-9]+)/i);
  return match ? { id: match[1], url: `https://www.reddit.com/comments/${match[1]}/` } : null;
}

function commentChildren(value) {
  return Array.isArray(value?.data?.children) ? value.data.children : [];
}

function flattenComments(listing, output = [], depth = 0, limit = 300) {
  for (const child of commentChildren(listing)) {
    if (output.length >= limit) break;
    if (child?.kind !== "t1" || !child.data) continue;
    const item = child.data;
    const body = String(item.body || "").trim();
    if (body && body !== "[deleted]" && body !== "[removed]") {
      output.push({
        author: item.author || "[deleted]",
        body,
        depth,
        score: Number(item.score) || 0,
        createdUtc: Number(item.created_utc) || 0,
        permalink: item.permalink ? new URL(item.permalink, "https://www.reddit.com").toString() : "",
      });
    }
    if (item.replies && typeof item.replies === "object") flattenComments(item.replies, output, depth + 1, limit);
  }
  return output;
}

function redditImages(post) {
  const images = [];
  const direct = String(post.url_overridden_by_dest || post.url || "");
  if (/\.(?:avif|gif|jpe?g|png|webp)(?:\?|$)/i.test(direct)) images.push(direct);
  for (const item of post.preview?.images || []) {
    const source = String(item?.source?.url || "").replace(/&amp;/g, "&");
    if (source) images.push(source);
  }
  for (const gallery of Object.values(post.media_metadata || {})) {
    const source = String(gallery?.s?.u || gallery?.s?.gif || "").replace(/&amp;/g, "&");
    if (source) images.push(source);
  }
  return [...new Set(images)];
}

function redditArticleFromPayload(payload, sourceUrl) {
  if (!Array.isArray(payload) || payload.length < 2) throw new Error("Reddit returned an unexpected response");
  const post = commentChildren(payload[0])[0]?.data;
  if (!post) throw new Error("Reddit post was not found");
  const comments = flattenComments(payload[1]);
  const permalink = post.permalink ? new URL(post.permalink, "https://www.reddit.com").toString() : sourceUrl;
  const lines = [];
  if (post.selftext) lines.push(post.selftext.trim());
  const external = String(post.url_overridden_by_dest || "");
  if (external && external !== permalink) lines.push(`[Linked page](${external})`);
  const images = redditImages(post);
  for (const image of images) lines.push(`![Reddit image](${image})`);
  lines.push("## Comments");
  if (!comments.length) lines.push("_No public comments were returned._");
  for (const comment of comments) {
    const indent = "  ".repeat(Math.min(comment.depth, 8));
    const attribution = `**u/${comment.author}** · ${comment.score} points${comment.permalink ? ` · [link](${comment.permalink})` : ""}`;
    lines.push(`${indent}- ${attribution}`);
    for (const line of comment.body.split("\n")) lines.push(`${indent}  ${line}`);
  }
  const markdown = lines.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
  return {
    url: permalink,
    title: post.title || `Reddit ${post.id || "post"}`,
    byline: post.author ? `u/${post.author}` : "",
    excerpt: String(post.selftext || post.title || "").slice(0, 240),
    siteName: post.subreddit_name_prefixed || "Reddit",
    markdown,
    images,
    contentChars: markdown.replace(/\s+/g, " ").length,
    extractionMethod: "reddit-json-comments",
    extractionStatus: "complete",
    commentCount: comments.length,
  };
}

async function extractRedditPost(value) {
  const parsed = parseRedditUrl(value);
  if (!parsed) return null;
  const endpoint = `https://www.reddit.com/comments/${parsed.id}.json?raw_json=1&limit=500&depth=10&sort=top`;
  const { response } = await safeFetch(endpoint, { accept: "application/json", timeoutMs: 30_000 });
  if (!response.ok) throw new Error(`Reddit returned HTTP ${response.status}`);
  const buffer = await readLimitedBody(response, 8 * 1024 * 1024);
  return redditArticleFromPayload(JSON.parse(buffer.toString("utf8")), parsed.url);
}

module.exports = { extractRedditPost, flattenComments, parseRedditUrl, redditArticleFromPayload, redditImages };
