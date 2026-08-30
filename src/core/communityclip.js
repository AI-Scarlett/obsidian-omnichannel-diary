"use strict";

const { parseHTML } = require("linkedom");
const { readLimitedBody, safeFetch } = require("./network");
const { communityServiceForUrl } = require("./web-platforms");

const JSON_LIMIT = 12 * 1024 * 1024;
const COMMENT_LIMIT = 300;

function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function htmlText(value) {
  const { document } = parseHTML(`<body>${String(value || "")}</body>`);
  return String(document.body?.textContent || "").replace(/\s+/g, " ").trim();
}

function safeHtml(value) {
  return String(value || "");
}

async function fetchJson(url, options = {}) {
  const { response, finalUrl } = await safeFetch(url, {
    accept: "application/json",
    timeoutMs: options.timeoutMs || 30_000,
    headers: options.headers,
  });
  if (!response.ok) throw new Error(`${options.label || "Community API"} returned HTTP ${response.status}`);
  const buffer = await readLimitedBody(response, options.maxBytes || JSON_LIMIT);
  return { data: JSON.parse(buffer.toString("utf8")), finalUrl };
}

function commentBlock({ author, html, createdAt, score, depth = 0, link = "", label = "Comment" }) {
  const trail = depth ? `${"↳".repeat(Math.min(depth, 8))} ` : "";
  const details = [htmlText(author) || "unknown", createdAt || "", Number.isFinite(score) ? `${score} points` : ""].filter(Boolean).join(" · ");
  return `<article class="community-comment" data-depth="${depth}"><h3>${trail}${escapeHtml(label)} · ${escapeHtml(details)}</h3>${safeHtml(html)}${link ? `<p><a href="${escapeHtml(link)}">Permalink</a></p>` : ""}</article>`;
}

function communityData({ url, title, byline, siteName, excerpt, bodyHtml, commentsHtml = "", commentCount = 0, extractionMethod, truncated = false }) {
  const commentsSection = commentsHtml
    ? `<section class="community-comments"><h2>Comments (${commentCount}${truncated ? "+" : ""})</h2>${commentsHtml}</section>`
    : "";
  return {
    url,
    title: htmlText(title) || siteName,
    byline: htmlText(byline),
    siteName,
    excerpt: htmlText(excerpt).slice(0, 240),
    contentHtml: `<article class="community-post">${bodyHtml || ""}</article>${commentsSection}`,
    commentCount,
    extractionMethod,
    extractionStatus: truncated ? "partial" : "complete",
  };
}

function parseHackerNewsUrl(value) {
  let url;
  try { url = new URL(value); } catch (_) { return null; }
  if (url.hostname !== "news.ycombinator.com" || url.pathname !== "/item") return null;
  const id = Number(url.searchParams.get("id"));
  return Number.isInteger(id) && id > 0 ? id : null;
}

function hackerNewsArticleData(story, comments, sourceUrl, truncated = false) {
  const external = story.url && story.url !== sourceUrl ? `<p><a href="${escapeHtml(story.url)}">Linked page</a></p>` : "";
  const storyText = safeHtml(story.text) || `<p>${escapeHtml(story.title || "Hacker News story")}</p>`;
  const commentsHtml = comments.map((item) => commentBlock({
    author: item.by, html: item.text, depth: item.depth, score: undefined,
    createdAt: item.time ? new Date(item.time * 1000).toISOString() : "",
    link: `https://news.ycombinator.com/item?id=${item.id}`,
  })).join("");
  return communityData({
    url: `https://news.ycombinator.com/item?id=${story.id}`,
    title: story.title,
    byline: story.by,
    siteName: "Hacker News",
    excerpt: story.text || story.title,
    bodyHtml: `<h1>${escapeHtml(story.title)}</h1><p>${escapeHtml(story.score || 0)} points · ${escapeHtml(story.by || "unknown")}</p>${storyText}${external}`,
    commentsHtml,
    commentCount: comments.length,
    extractionMethod: "hackernews-official-api-comments",
    truncated,
  });
}

async function extractHackerNews(value) {
  const id = parseHackerNewsUrl(value);
  if (!id) return null;
  const endpoint = (itemId) => `https://hacker-news.firebaseio.com/v0/item/${itemId}.json`;
  const story = (await fetchJson(endpoint(id), { label: "Hacker News API" })).data;
  if (!story?.id) throw new Error("Hacker News story was not found");
  const queue = (story.kids || []).map((childId) => ({ id: childId, depth: 0 }));
  const comments = [];
  const seen = new Set();
  let missed = 0;
  while (queue.length && comments.length < COMMENT_LIMIT) {
    const batch = queue.splice(0, 12).filter((item) => !seen.has(item.id));
    batch.forEach((item) => seen.add(item.id));
    const items = await Promise.all(batch.map(async (queued) => {
      try { return { queued, item: (await fetchJson(endpoint(queued.id), { label: "Hacker News API" })).data }; }
      catch (_) { return { queued, item: null }; }
    }));
    for (const { queued, item } of items) {
      if (!item) { missed += 1; continue; }
      if (item.deleted || item.dead || item.type !== "comment") continue;
      if (item.text) comments.push({ ...item, depth: queued.depth });
      for (const childId of item.kids || []) queue.push({ id: childId, depth: queued.depth + 1 });
      if (comments.length >= COMMENT_LIMIT) break;
    }
  }
  return hackerNewsArticleData(story, comments, value, queue.length > 0 || missed > 0);
}

function flattenForemComments(items, output = [], depth = 0) {
  for (const item of items || []) {
    if (output.length >= COMMENT_LIMIT) break;
    output.push({ ...item, depth });
    flattenForemComments(item.children, output, depth + 1);
  }
  return output;
}

function devArticleData(article, commentThreads, sourceUrl) {
  const comments = flattenForemComments(commentThreads);
  const commentsHtml = comments.map((item) => commentBlock({
    author: item.user?.name || item.user?.username,
    html: item.body_html,
    depth: item.depth,
    createdAt: item.created_at,
    link: item.id_code ? `https://dev.to/comments/${item.id_code}` : "",
  })).join("");
  return communityData({
    url: article.url || sourceUrl,
    title: article.title,
    byline: article.user?.name || article.user?.username,
    siteName: "DEV Community",
    excerpt: article.description,
    bodyHtml: `<h1>${escapeHtml(article.title)}</h1>${safeHtml(article.body_html)}`,
    commentsHtml,
    commentCount: comments.length,
    extractionMethod: "forem-official-api-comments",
    truncated: comments.length >= COMMENT_LIMIT,
  });
}

async function extractDev(value) {
  let url;
  try { url = new URL(value); } catch (_) { return null; }
  const parts = url.pathname.split("/").filter(Boolean);
  if (url.hostname !== "dev.to" || parts.length < 2) return null;
  const article = (await fetchJson(`https://dev.to/api/articles/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts.slice(1).join("/"))}`, { label: "DEV API" })).data;
  const comments = article.id ? (await fetchJson(`https://dev.to/api/comments?a_id=${article.id}`, { label: "DEV API" })).data : [];
  return devArticleData(article, comments, value);
}

function stackSite(hostname) {
  const host = String(hostname).replace(/^www\./, "");
  if (host.endsWith(".stackexchange.com")) return host.slice(0, -".stackexchange.com".length);
  return ({ "stackoverflow.com": "stackoverflow", "serverfault.com": "serverfault", "superuser.com": "superuser", "askubuntu.com": "askubuntu", "mathoverflow.net": "mathoverflow" })[host] || null;
}

function parseStackExchangeUrl(value) {
  let url;
  try { url = new URL(value); } catch (_) { return null; }
  const match = url.pathname.match(/\/questions\/(\d+)/i);
  const site = stackSite(url.hostname);
  return match && site ? { id: Number(match[1]), site, url } : null;
}

function stackExchangeArticleData(question, answers, comments, sourceUrl) {
  const answerHtml = answers.map((answer) => {
    const answerComments = comments.filter((item) => item.post_id === answer.answer_id);
    return `<section class="answer"><h2>${answer.is_accepted ? "Accepted answer" : "Answer"} · ${answer.score || 0} points · ${escapeHtml(answer.owner?.display_name || "unknown")}</h2>${safeHtml(answer.body)}${answerComments.map((item) => commentBlock({ author: item.owner?.display_name, html: item.body, score: item.score, createdAt: item.creation_date ? new Date(item.creation_date * 1000).toISOString() : "" })).join("")}</section>`;
  }).join("");
  const questionComments = comments.filter((item) => item.post_id === question.question_id);
  return communityData({
    url: question.link || sourceUrl,
    title: question.title,
    byline: question.owner?.display_name,
    siteName: "Stack Exchange",
    excerpt: question.body,
    bodyHtml: `<h1>${safeHtml(question.title)}</h1><p>${question.score || 0} points · ${escapeHtml(question.owner?.display_name || "unknown")}</p>${safeHtml(question.body)}${questionComments.map((item) => commentBlock({ author: item.owner?.display_name, html: item.body, score: item.score })).join("")}${answerHtml}`,
    commentCount: answers.length + comments.length,
    extractionMethod: "stackexchange-official-api-answers-comments",
    truncated: answers.length >= 100 || comments.length >= COMMENT_LIMIT,
  });
}

async function extractStackExchange(value) {
  const parsed = parseStackExchangeUrl(value);
  if (!parsed) return null;
  const query = `site=${encodeURIComponent(parsed.site)}&pagesize=100&filter=withbody`;
  const question = (await fetchJson(`https://api.stackexchange.com/2.3/questions/${parsed.id}?${query}`, { label: "Stack Exchange API" })).data.items?.[0];
  if (!question) throw new Error("Stack Exchange question was not found");
  const answers = (await fetchJson(`https://api.stackexchange.com/2.3/questions/${parsed.id}/answers?${query}&sort=votes`, { label: "Stack Exchange API" })).data.items || [];
  const questionComments = (await fetchJson(`https://api.stackexchange.com/2.3/questions/${parsed.id}/comments?site=${encodeURIComponent(parsed.site)}&pagesize=100&filter=withbody`, { label: "Stack Exchange API" })).data.items || [];
  let answerComments = [];
  if (answers.length) {
    const ids = answers.map((item) => item.answer_id).join(";");
    answerComments = (await fetchJson(`https://api.stackexchange.com/2.3/answers/${ids}/comments?site=${encodeURIComponent(parsed.site)}&pagesize=100&filter=withbody`, { label: "Stack Exchange API" })).data.items || [];
  }
  return stackExchangeArticleData(question, answers, [...questionComments, ...answerComments], value);
}

function parseGitHubUrl(value) {
  let url;
  try { url = new URL(value); } catch (_) { return null; }
  if (url.hostname !== "github.com") return null;
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)/i);
  return match ? { owner: match[1], repo: match[2], kind: match[3].toLowerCase(), number: Number(match[4]), url } : null;
}

function githubArticleData(issue, comments, reviews, sourceUrl) {
  const all = [
    ...comments.map((item) => ({ ...item, label: "Comment" })),
    ...reviews.map((item) => ({ ...item, label: "Review comment" })),
  ].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const commentsHtml = all.map((item) => commentBlock({
    author: item.user?.login,
    html: item.body_html || `<pre>${escapeHtml(item.body || "")}</pre>`,
    createdAt: item.created_at,
    link: item.html_url,
    label: item.label,
  })).join("");
  return communityData({
    url: issue.html_url || sourceUrl,
    title: issue.title,
    byline: issue.user?.login,
    siteName: "GitHub",
    excerpt: issue.body_text || issue.body,
    bodyHtml: `<h1>${escapeHtml(issue.title)}</h1><p>${escapeHtml(issue.state || "")} · ${escapeHtml(issue.user?.login || "unknown")}</p>${issue.body_html || `<pre>${escapeHtml(issue.body || "")}</pre>`}`,
    commentsHtml,
    commentCount: all.length,
    extractionMethod: "github-rest-api-comments",
    truncated: comments.length >= 100 || reviews.length >= 100,
  });
}

async function extractGitHub(value) {
  const parsed = parseGitHubUrl(value);
  if (!parsed) return null;
  const base = `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`;
  const headers = { accept: "application/vnd.github.html+json", "x-github-api-version": "2022-11-28" };
  const issue = (await fetchJson(`${base}/issues/${parsed.number}`, { label: "GitHub API", headers })).data;
  const comments = (await fetchJson(`${base}/issues/${parsed.number}/comments?per_page=100`, { label: "GitHub API", headers })).data || [];
  let reviews = [];
  if (parsed.kind === "pull") {
    reviews = (await fetchJson(`${base}/pulls/${parsed.number}/comments?per_page=100`, { label: "GitHub API", headers })).data || [];
  }
  return githubArticleData(issue, comments, reviews, value);
}

function discourseArticleData(topic, sourceUrl) {
  const posts = topic?.post_stream?.posts || [];
  const first = posts[0] || {};
  const comments = posts.slice(1, COMMENT_LIMIT + 1);
  const commentsHtml = comments.map((item) => commentBlock({
    author: item.name || item.username,
    html: item.cooked,
    createdAt: item.created_at,
    depth: item.reply_to_post_number ? 1 : 0,
    link: `${sourceUrl.replace(/\/$/, "")}/${item.post_number}`,
    label: `Post #${item.post_number}`,
  })).join("");
  return communityData({
    url: sourceUrl,
    title: topic.title,
    byline: first.name || first.username,
    siteName: "Discourse",
    excerpt: first.cooked,
    bodyHtml: `<h1>${escapeHtml(topic.title)}</h1>${safeHtml(first.cooked)}`,
    commentsHtml,
    commentCount: comments.length,
    extractionMethod: "discourse-public-json-comments",
    truncated: Math.max(posts.length, topic?.post_stream?.stream?.length || 0) - 1 > comments.length,
  });
}

async function extractDiscourse(value) {
  let url;
  try { url = new URL(value); } catch (_) { return null; }
  if (!/\/t\//i.test(url.pathname)) return null;
  url.hash = "";
  url.search = "";
  url.pathname = `${url.pathname.replace(/\/$/, "").replace(/\.json$/i, "")}.json`;
  const topic = (await fetchJson(url.toString(), { label: "Discourse JSON" })).data;
  const loaded = new Set((topic?.post_stream?.posts || []).map((post) => post.id));
  const missing = (topic?.post_stream?.stream || []).filter((id) => !loaded.has(id)).slice(0, COMMENT_LIMIT);
  for (let index = 0; index < missing.length; index += 50) {
    const endpoint = new URL(`/t/${topic.id}/posts.json`, url.origin);
    for (const id of missing.slice(index, index + 50)) endpoint.searchParams.append("post_ids[]", String(id));
    try {
      const extra = (await fetchJson(endpoint.toString(), { label: "Discourse JSON" })).data?.post_stream?.posts || [];
      topic.post_stream.posts.push(...extra);
    } catch (_) { break; }
  }
  topic.post_stream.posts.sort((a, b) => (a.post_number || 0) - (b.post_number || 0));
  const rawCanonical = String(topic?.post_stream?.posts?.[0]?.post_url || value).replace(/\.json$/i, "");
  const canonical = new URL(rawCanonical, value).toString();
  return discourseArticleData(topic, canonical);
}

function v2exArticleData(topic, replies, sourceUrl) {
  const comments = (replies || []).slice(0, COMMENT_LIMIT);
  const commentsHtml = comments.map((item) => commentBlock({
    author: item.member?.username,
    html: item.content_rendered || `<p>${escapeHtml(item.content || "")}</p>`,
    createdAt: item.created ? new Date(item.created * 1000).toISOString() : "",
    link: `${sourceUrl}#reply${item.id}`,
    label: `#${item.id}`,
  })).join("");
  return communityData({
    url: topic.url || sourceUrl,
    title: topic.title,
    byline: topic.member?.username,
    siteName: "V2EX",
    excerpt: topic.content,
    bodyHtml: `<h1>${escapeHtml(topic.title)}</h1>${topic.content_rendered || `<p>${escapeHtml(topic.content || "")}</p>`}`,
    commentsHtml,
    commentCount: comments.length,
    extractionMethod: "v2ex-public-api-comments",
    truncated: (replies || []).length > comments.length,
  });
}

async function extractV2ex(value) {
  let url;
  try { url = new URL(value); } catch (_) { return null; }
  const match = url.pathname.match(/\/t\/(\d+)/i);
  if (!match) return null;
  const id = Number(match[1]);
  const topics = (await fetchJson(`https://www.v2ex.com/api/topics/show.json?id=${id}`, { label: "V2EX API" })).data;
  const topic = Array.isArray(topics) ? topics[0] : null;
  if (!topic) throw new Error("V2EX topic was not found");
  const replies = (await fetchJson(`https://www.v2ex.com/api/replies/show.json?topic_id=${id}`, { label: "V2EX API" })).data;
  return v2exArticleData(topic, replies, value);
}

async function extractCommunityPost(value) {
  const service = communityServiceForUrl(value);
  if (service === "hackernews") return extractHackerNews(value);
  if (service === "devto") return extractDev(value);
  if (service === "stackexchange") return extractStackExchange(value);
  if (service === "github") return extractGitHub(value);
  if (service === "discourse") return extractDiscourse(value);
  if (service === "v2ex") return extractV2ex(value);
  // Discourse instances frequently use custom domains. The public topic JSON
  // convention is stable enough to probe, while failures fall back to HTML.
  try { if (!service && /\/t\/[^/]+\/\d+/i.test(new URL(value).pathname)) return extractDiscourse(value); } catch (_) {}
  return null;
}

module.exports = {
  COMMENT_LIMIT,
  communityData,
  devArticleData,
  discourseArticleData,
  escapeHtml,
  htmlText,
  extractCommunityPost,
  githubArticleData,
  hackerNewsArticleData,
  parseGitHubUrl,
  parseHackerNewsUrl,
  parseStackExchangeUrl,
  stackExchangeArticleData,
  v2exArticleData,
};
