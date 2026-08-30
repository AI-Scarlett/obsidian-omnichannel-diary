"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CODE_PLATFORM_SERVICES,
  CodePlatformBookmarkStore,
  classifyCodePlatformUrl,
  codePlatformCoverage,
  normalizeAdditionalHosts,
  normalizeCodePlatformMode,
} = require("../src/core/code-platforms");

test("the registry covers major international and Chinese code platforms", () => {
  assert.ok(Object.keys(CODE_PLATFORM_SERVICES).length >= 18);
  for (const name of ["GitHub", "GitLab", "Bitbucket", "Azure DevOps", "Codeberg", "SourceHut", "SourceForge", "Hugging Face Hub"]) {
    assert.ok(codePlatformCoverage("international").some((item) => item.name === name), name);
  }
  for (const name of ["Gitee", "GitCode", "JiHu GitLab", "CODING", "AtomGit", "GitLink"]) {
    assert.ok(codePlatformCoverage("china").some((item) => item.name === name), name);
  }
});

test("repository and resource URLs are classified without opening the page", () => {
  const cases = [
    ["https://github.com/openai/openai-node/issues/123?utm_source=chat", "github", "openai/openai-node", "issue", "123"],
    ["https://gitlab.com/gitlab-org/gitlab/-/merge_requests/1", "gitlab", "gitlab-org/gitlab", "merge-request", "1"],
    ["https://bitbucket.org/atlassian/python-bitbucket/src/main/", "bitbucket", "atlassian/python-bitbucket", "file", "main"],
    ["https://dev.azure.com/contoso/MyProject/_git/MyRepo?path=/README.md", "azure", "contoso/MyProject/MyRepo", "file", "/README.md"],
    ["https://codeberg.org/forgejo/forgejo/pulls/99", "codeberg", "forgejo/forgejo", "pull-request", "99"],
    ["https://git.sr.ht/~sircmpwn/hare", "sourcehut", "~sircmpwn/hare", "repository", ""],
    ["https://sourceforge.net/projects/sevenzip/files/", "sourceforge", "sevenzip", "file", ""],
    ["https://huggingface.co/datasets/openai/gsm8k/blob/main/README.md", "huggingface", "datasets/openai/gsm8k", "file", "main"],
    ["https://gitee.com/oschina/git-osc/issues/ABC123", "gitee", "oschina/git-osc", "issue", "ABC123"],
    ["https://gitcode.com/opencv/opencv/-/blob/master/README.md", "gitcode", "opencv/opencv", "file", "master"],
    ["https://e.coding.net/u/foo/p/bar/d/repo/git/tree/main", "coding", "foo/bar/repo", "tree", "main"],
    ["https://atomgit.com/OpenAtomFoundation/pika", "atomgit", "OpenAtomFoundation/pika", "repository", ""],
  ];
  for (const [url, id, repository, resourceType, resourceId] of cases) {
    const actual = classifyCodePlatformUrl(url);
    assert.ok(actual, url);
    assert.equal(actual.id, id, url);
    assert.equal(actual.repository, repository, url);
    assert.equal(actual.resourceType, resourceType, url);
    assert.equal(actual.resourceId, resourceId, url);
  }
  assert.equal(classifyCodePlatformUrl("https://github.com/login"), null);
  assert.equal(classifyCodePlatformUrl("https://example.com/owner/repo"), null);
});

test("self-hosted GitLab, Gitea, and Forgejo hosts can be added by the user", () => {
  assert.deepEqual(normalizeAdditionalHosts("https://git.example.com/path, code.example.org，git.example.com"), ["git.example.com", "code.example.org"]);
  const info = classifyCodePlatformUrl("https://git.example.com/team/subteam/repo/-/issues/7", "git.example.com");
  assert.equal(info.name, "git.example.com");
  assert.equal(info.repository, "team/subteam/repo");
  assert.equal(info.resourceType, "issue");
  assert.equal(classifyCodePlatformUrl("https://git.example.com/login", "git.example.com"), null);
});

test("invalid code-platform modes fall back to extraction for backward compatibility", () => {
  assert.equal(normalizeCodePlatformMode("bookmark"), "bookmark");
  assert.equal(normalizeCodePlatformMode("both"), "both");
  assert.equal(normalizeCodePlatformMode("unknown"), "extract");
});

test("bookmark-only storage creates an idempotent categorized Markdown note", async () => {
  const writes = [];
  const writer = { upsertText: async (path, content) => writes.push({ path, content }) };
  const store = new CodePlatformBookmarkStore(writer, {
    storage: { codePlatformFolder: "代码平台收藏" },
    capture: { codePlatformAdditionalHosts: "" },
  });
  const saved = await store.save("https://github.com/openai/openai-node/issues/123?utm_source=chat", {
    channel: "wechat",
    timestamp: new Date("2026-08-31T04:00:00.000Z"),
  });
  assert.match(saved.notePath, /^代码平台收藏\/GitHub\/openai-openai-node-Issue 123-[a-f0-9]{12}\.md$/);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, saved.notePath);
  assert.match(writes[0].content, /type: code-platform-link/);
  assert.match(writes[0].content, /repository: "openai\/openai-node"/);
  assert.match(writes[0].content, /resource_type: "issue"/);
  assert.match(writes[0].content, /https:\/\/github\.com\/openai\/openai-node\/issues\/123/);
  assert.doesNotMatch(writes[0].content, /utm_source/);
});
