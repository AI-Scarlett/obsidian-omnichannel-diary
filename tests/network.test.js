"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { isTrustedSyntheticDnsUrl, nodeRequest, parsePublicDnsAnswer, readLimitedBody, requestWithRetry, validateResolvedHost } = require("../src/core/network");

test("node transport returns a fetch-like streaming response", async (t) => {
  const server = http.createServer((request, response) => {
    assert.equal(request.headers["x-transport"], "node");
    assert.equal(request.headers["content-length"], "7");
    response.writeHead(200, { "content-type": "application/json", "content-length": "11" });
    response.end('{"ok":true}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  const response = await nodeRequest(`http://127.0.0.1:${address.port}/`, { method: "POST", headers: { "x-transport": "node" }, body: "payload" });
  assert.equal(response.ok, true);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal((await readLimitedBody(response, 100)).toString("utf8"), '{"ok":true}');
});

test("node transport preserves body size enforcement", async (t) => {
  const server = http.createServer((_request, response) => response.end("too large"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const response = await nodeRequest(`http://127.0.0.1:${address.port}/`);
  await assert.rejects(() => readLimitedBody(response, 3), /exceeds 3 bytes/);
});

test("transport retries transient TLS resets but does not repeat unsafe methods by default", async () => {
  let getAttempts = 0;
  const response = await requestWithRetry("https://example.com", { method: "GET", retryDelays: [0] }, async () => {
    getAttempts += 1;
    if (getAttempts < 3) throw Object.assign(new Error("socket disconnected"), { code: "ECONNRESET" });
    return { ok: true };
  });
  assert.equal(response.ok, true);
  assert.equal(getAttempts, 3);

  let postAttempts = 0;
  await assert.rejects(() => requestWithRetry("https://example.com", { method: "POST", retryDelays: [0] }, async () => {
    postAttempts += 1;
    throw Object.assign(new Error("socket disconnected"), { code: "ECONNRESET" });
  }), /socket disconnected/);
  assert.equal(postAttempts, 1);
});

test("resolved private addresses stay blocked unless an exact caller predicate trusts the hostname", async () => {
  const lookup = async () => [{ address: "172.19.0.8", family: 4 }];
  await assert.rejects(
    () => validateResolvedHost("https://example.com/path", { lookup, publicLookup: async () => [] }),
    /local or private network/,
  );

  const parsed = await validateResolvedHost("https://api.example.com/path", {
    lookup,
    allowPrivateResolvedHost: (url) => url.protocol === "https:" && url.hostname === "api.example.com",
  });
  assert.equal(parsed.hostname, "api.example.com");

  await assert.rejects(
    () => validateResolvedHost("https://other.example.com/path", {
      lookup,
      publicLookup: async () => [],
      allowPrivateResolvedHost: (url) => url.hostname === "api.example.com",
    }),
    /local or private network/,
  );
});

test("synthetic DNS compatibility is restricted to official X and WeChat HTTPS domains", async () => {
  const lookup = async () => [{ address: "172.19.0.91", family: 4 }];
  for (const url of [
    "https://x.com/user/status/1234567890",
    "https://api.x.com/graphql/query",
    "https://publish.twitter.com/oembed",
    "https://pbs.twimg.com/media/example.jpg",
    "https://mp.weixin.qq.com/s/example",
    "https://mmbiz.qpic.cn/example.jpg",
  ]) {
    assert.equal(isTrustedSyntheticDnsUrl(url), true);
    assert.equal((await validateResolvedHost(url, { lookup })).protocol, "https:");
  }
  for (const url of [
    "http://x.com/user/status/1234567890",
    "https://x.com.evil.example/path",
    "https://weixin.qq.com.evil.example/path",
    "https://example.com/path",
  ]) {
    assert.equal(isTrustedSyntheticDnsUrl(url), false);
    await assert.rejects(() => validateResolvedHost(url, { lookup, publicLookup: async () => [] }), /local or private network/);
  }
});

test("public DNS confirmation permits proxy-mapped public hosts but not public names that resolve privately", async () => {
  const proxyLookup = async () => [{ address: "172.19.1.33", family: 4 }];
  const confirmed = await validateResolvedHost("https://resources.anthropic.com/guide.pdf", {
    lookup: proxyLookup,
    publicLookup: async () => [{ address: "199.60.103.2", family: 4 }],
  });
  assert.equal(confirmed.hostname, "resources.anthropic.com");
  await assert.rejects(() => validateResolvedHost("https://intranet.example.com/file", {
    lookup: proxyLookup,
    publicLookup: async () => [{ address: "10.0.0.8", family: 4 }],
  }), /local or private network/);
  await assert.rejects(() => validateResolvedHost("https://unknown.example.com/file", {
    lookup: proxyLookup,
    publicLookup: async () => { throw new Error("offline"); },
  }), /local or private network/);
});

test("public DNS JSON parsing ignores CNAMEs and keeps only IP answers", () => {
  assert.deepEqual(parsePublicDnsAnswer({ Answer: [
    { type: 5, data: "alias.example.net." },
    { type: 1, data: "203.0.113.12" },
    { type: 28, data: "2001:db8::12" },
  ] }), ["203.0.113.12", "2001:db8::12"]);
});
