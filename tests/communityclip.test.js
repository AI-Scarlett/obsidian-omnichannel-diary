"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  devArticleData,
  discourseArticleData,
  githubArticleData,
  hackerNewsArticleData,
  stackExchangeArticleData,
  v2exArticleData,
} = require("../src/core/communityclip");
const { communityCoverage, communityServiceForUrl } = require("../src/core/web-platforms");

test("community registry covers major international and Chinese detail pages", () => {
  const cases = {
    "https://news.ycombinator.com/item?id=8863": "hackernews",
    "https://github.com/org/repo/discussions/12": "github",
    "https://stackoverflow.com/questions/1732348/example": "stackexchange",
    "https://dev.to/alice/a-post": "devto",
    "https://community.obsidian.md/t/a-topic/123": "discourse",
    "https://medium.com/@alice/a-post-abc123": "medium",
    "https://alice.hashnode.dev/a-post": "hashnode",
    "https://alice.substack.com/p/a-post": "substack",
    "https://lobste.rs/s/abc123/a_story": "lobsters",
    "https://huggingface.co/spaces/a/b/discussions/3": "huggingface",
    "https://www.v2ex.com/t/123": "v2ex",
    "https://juejin.cn/post/123": "juejin",
    "https://blog.csdn.net/alice/article/details/123": "csdn",
    "https://www.cnblogs.com/alice/p/123456.html": "cnblogs",
    "https://segmentfault.com/a/1190000000000000": "segmentfault",
    "https://www.oschina.net/news/123/example": "oschina",
    "https://www.zhihu.com/question/1/answer/2": "zhihu",
    "https://sspai.com/post/123": "sspai",
    "https://cloud.tencent.com/developer/article/123": "tencentcloud",
    "https://developer.aliyun.com/article/123": "aliyun",
    "https://gitee.com/org/repo/issues/I123": "gitee",
    "https://gitcode.com/org/repo/issues/123": "gitcode",
  };
  for (const [url, expected] of Object.entries(cases)) assert.equal(communityServiceForUrl(url), expected, url);
  assert.ok(communityCoverage("international").length >= 14);
  assert.ok(communityCoverage("china").length >= 13);
});

test("Hacker News payload retains nested comments and linked story", () => {
  const article = hackerNewsArticleData(
    { id: 10, title: "A story", by: "alice", score: 42, url: "https://example.com/post" },
    [{ id: 11, by: "bob", text: "<p>First</p>", depth: 0 }, { id: 12, by: "carol", text: "<p>Reply</p>", depth: 1 }],
    "https://news.ycombinator.com/item?id=10",
  );
  assert.equal(article.commentCount, 2);
  assert.equal(article.extractionMethod, "hackernews-official-api-comments");
  assert.match(article.contentHtml, /Linked page/);
  assert.match(article.contentHtml, /↳/);
});

test("Forem payload keeps an article and threaded comments", () => {
  const article = devArticleData(
    { id: 1, title: "DEV post", description: "Summary", url: "https://dev.to/a/b", body_html: "<p>Body</p>", user: { name: "Alice" } },
    [{ body_html: "<p>Top</p>", user: { username: "bob" }, children: [{ body_html: "<p>Nested</p>", user: { username: "carol" }, children: [] }] }],
    "https://dev.to/a/b",
  );
  assert.equal(article.commentCount, 2);
  assert.match(article.contentHtml, /Nested/);
  assert.equal(article.extractionMethod, "forem-official-api-comments");
});

test("Stack Exchange payload retains question, answers, and post comments", () => {
  const article = stackExchangeArticleData(
    { question_id: 1, title: "How?", body: "<p>Question</p>", owner: { display_name: "Alice" }, link: "https://stackoverflow.com/questions/1" },
    [{ answer_id: 2, body: "<p>Answer</p>", score: 5, is_accepted: true, owner: { display_name: "Bob" } }],
    [{ post_id: 1, body: "Question comment", owner: { display_name: "Carol" } }, { post_id: 2, body: "Answer comment", owner: { display_name: "Dan" } }],
    "https://stackoverflow.com/questions/1",
  );
  assert.equal(article.commentCount, 3);
  assert.match(article.contentHtml, /Accepted answer/);
  assert.match(article.contentHtml, /Answer comment/);
});

test("GitHub payload joins issue and review comments", () => {
  const article = githubArticleData(
    { title: "Bug", state: "open", html_url: "https://github.com/a/b/issues/1", body_html: "<p>Details</p>", user: { login: "alice" } },
    [{ body_html: "<p>Issue comment</p>", created_at: "2026-01-01", user: { login: "bob" } }],
    [{ body_html: "<p>Review</p>", created_at: "2026-01-02", user: { login: "carol" } }],
    "https://github.com/a/b/issues/1",
  );
  assert.equal(article.commentCount, 2);
  assert.match(article.contentHtml, /Review comment/);
  assert.equal(article.extractionMethod, "github-rest-api-comments");
});

test("Discourse and V2EX payloads retain ordered replies", () => {
  const discourse = discourseArticleData({ title: "Topic", post_stream: { posts: [
    { username: "alice", cooked: "<p>Opening</p>", post_number: 1 },
    { username: "bob", cooked: "<p>Reply</p>", post_number: 2, reply_to_post_number: 1 },
  ] } }, "https://community.example/t/topic/1");
  const v2ex = v2exArticleData(
    { title: "V2EX topic", content_rendered: "<p>Opening</p>", member: { username: "alice" } },
    [{ id: 2, content_rendered: "<p>Reply</p>", member: { username: "bob" } }],
    "https://www.v2ex.com/t/1",
  );
  assert.equal(discourse.commentCount, 1);
  assert.match(discourse.contentHtml, /Post #2/);
  assert.equal(v2ex.commentCount, 1);
  assert.match(v2ex.contentHtml, /Reply/);
});
