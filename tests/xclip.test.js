"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { articleFromPayload, draftBlocksToMarkdown, parseXStatusUrl } = require("../src/core/xclip");

test("X status URLs are recognized without retaining tracking parameters", () => {
  assert.deepEqual(parseXStatusUrl("https://x.com/Author/status/2093502767776366755?s=46"), {
    username: "Author",
    id: "2093502767776366755",
    url: "https://x.com/Author/status/2093502767776366755",
  });
  assert.equal(parseXStatusUrl("https://x.com/i/article/2089293057313353728"), null);
  assert.equal(parseXStatusUrl("https://example.com/Author/status/2093502767776366755"), null);
});

test("X DraftJS article blocks preserve structure, embedded markdown, and media", () => {
  const article = {
    media_entities: [{ media_id: "42", media_info: { original_img_url: "https://pbs.twimg.com/media/body.jpg", alt_text: "body" } }],
  };
  const content = {
    blocks: [
      { type: "header-one", text: "Section" },
      { type: "unordered-list-item", text: "Item" },
      { type: "atomic", entity_ranges: [{ key: 1 }] },
      { type: "atomic", entity_ranges: [{ key: 2 }] },
    ],
    entity_map: [
      { key: "1", value: { type: "MARKDOWN", data: { markdown: "```\nflow\n```" } } },
      { key: "2", value: { type: "MEDIA", data: { media_items: [{ media_id: "42" }] } } },
    ],
  };
  assert.equal(draftBlocksToMarkdown(content, article), "## Section\n\n- Item\n\n```\nflow\n```\n\n![body](https://pbs.twimg.com/media/body.jpg)");
});

test("X Article API payload becomes a complete clipping with cover and author", () => {
  const payload = { data: { tweet_result_by_rest_id: { result: {
    core: { user_results: { result: { core: { name: "Writer", screen_name: "writer" } } } },
    article: { article_results: { result: {
      title: "Long article",
      plain_text: "A".repeat(140),
      preview_text: "Preview",
      content_state: { blocks: [{ type: "unstyled", text: "A".repeat(140) }], entity_map: [] },
      cover_media_results: { result: { media_info: { original_img_url: "https://pbs.twimg.com/media/cover.jpg" } } },
      media_entities: [],
    } } },
  } } } };
  const article = articleFromPayload(payload, { username: "writer", id: "123", url: "https://x.com/writer/status/123" });
  assert.equal(article.title, "Long article");
  assert.equal(article.byline, "Writer (@writer)");
  assert.equal(article.extractionStatus, "complete");
  assert.deepEqual(article.images, ["https://pbs.twimg.com/media/cover.jpg"]);
  assert.match(article.markdown, /^!\[X Article cover\]/);
});
