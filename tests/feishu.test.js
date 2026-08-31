"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { FeishuApiClient, FeishuChannel, apiDomainForRegion, streamResponse } = require("../src/channels/feishu");

test("Feishu and Lark lightweight API calls use absolute official API domains", () => {
  assert.equal(apiDomainForRegion("feishu"), "https://open.feishu.cn");
  assert.equal(apiDomainForRegion("lark"), "https://open.larksuite.com");
  assert.equal(new FeishuChannel({ domain: "feishu" }, {}).apiDomain, "https://open.feishu.cn");
  assert.equal(new FeishuChannel({ domain: "lark" }, {}).apiDomain, "https://open.larksuite.com");
});

test("Feishu lightweight API client caches tokens and uses only scoped message endpoints", async () => {
  const calls = [];
  const http = {
    post: async (url, data, options) => {
      calls.push({ method: "POST", url, data, options });
      if (url.endsWith("/tenant_access_token/internal")) return { code: 0, tenant_access_token: "tenant-token", expire: 7200 };
      return { code: 0, data: { message_id: "reply-1" } };
    },
    get: async (url, options) => {
      calls.push({ method: "GET", url, options });
      return { data: Buffer.from("image"), headers: { "content-type": "image/png" } };
    },
  };
  const client = new FeishuApiClient({ appId: "cli_test", appSecret: "secret" }, "https://open.feishu.cn/", http);
  await client.reply("chat id", "saved");
  const resource = await client.resource("message/id", "file key", "image");
  assert.equal(calls.filter((call) => call.url.endsWith("/tenant_access_token/internal")).length, 1);
  assert.match(calls[1].url, /\/open-apis\/im\/v1\/messages$/);
  assert.equal(calls[1].options.headers.Authorization, "Bearer tenant-token");
  assert.match(calls[2].url, /messages\/message%2Fid\/resources\/file%20key$/);
  assert.equal(calls[2].options.params.type, "image");
  assert.deepEqual(streamResponse(resource, "image.png", "image/jpeg"), {
    buffer: Buffer.from("image"),
    fileName: "image.png",
    mimeType: "image/png",
  });
});
