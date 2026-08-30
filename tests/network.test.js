"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { nodeRequest, readLimitedBody, requestWithRetry } = require("../src/core/network");

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
