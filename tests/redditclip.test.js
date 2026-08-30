"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { flattenComments, parseRedditUrl, redditArticleFromPayload } = require("../src/core/redditclip");

function listing(children) {
  return { data: { children } };
}

test("Reddit post URLs and redd.it short links are recognized", () => {
  assert.equal(parseRedditUrl("https://www.reddit.com/r/javascript/comments/abc123/a_post/").id, "abc123");
  assert.equal(parseRedditUrl("https://old.reddit.com/comments/xyz789/").id, "xyz789");
  assert.equal(parseRedditUrl("https://redd.it/qwerty").id, "qwerty");
  assert.equal(parseRedditUrl("https://example.com/comments/abc"), null);
});

test("Reddit payload preserves the post, nested comments, links, and images", () => {
  const replies = listing([{ kind: "t1", data: { author: "bob", body: "Nested answer", score: 3, permalink: "/r/test/comments/abc/title/c2" } }]);
  const payload = [
    listing([{ kind: "t3", data: {
      id: "abc", title: "A useful launch", author: "alice", subreddit_name_prefixed: "r/test", selftext: "Post body",
      permalink: "/r/test/comments/abc/title/", url_overridden_by_dest: "https://example.com/launch",
      preview: { images: [{ source: { url: "https://images.example.com/cover.jpg?x=1&amp;y=2" } }] },
    } }]),
    listing([{ kind: "t1", data: { author: "carol", body: "Top comment", score: 12, permalink: "/r/test/comments/abc/title/c1", replies } }]),
  ];
  const article = redditArticleFromPayload(payload, "https://www.reddit.com/comments/abc/");
  assert.equal(article.title, "A useful launch");
  assert.equal(article.commentCount, 2);
  assert.equal(article.extractionMethod, "reddit-json-comments");
  assert.match(article.markdown, /## Comments/);
  assert.match(article.markdown, /u\/carol/);
  assert.match(article.markdown, /Nested answer/);
  assert.match(article.markdown, /\[Linked page\]\(https:\/\/example.com\/launch\)/);
  assert.deepEqual(article.images, ["https://images.example.com/cover.jpg?x=1&y=2"]);
  assert.equal(flattenComments(payload[1]).length, 2);
});
