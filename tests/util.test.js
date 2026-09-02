"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { assertSafeRemoteUrl, encodeMultipart, exportMimeType, extractUrls, isPrivateHost, safeFileName } = require("../src/core/util");
const { decodeDataUrl, readLimitedBody } = require("../src/core/network");

test("URL extraction de-duplicates links and trims sentence punctuation", () => {
  assert.deepEqual(extractUrls("看 https://example.com/a。 再看 https://example.com/a!"), ["https://example.com/a"]);
});

test("remote URL guard rejects local networks", () => {
  for (const host of ["localhost", "127.0.0.1", "10.2.3.4", "172.20.1.2", "192.168.1.1", "::1", "fd00::1"]) {
    assert.equal(isPrivateHost(host), true, host);
  }
  assert.throws(() => assertSafeRemoteUrl("http://127.0.0.1/private"));
  assert.equal(assertSafeRemoteUrl("https://example.com/article").hostname, "example.com");
});

test("file names cannot escape the vault folder", () => {
  assert.equal(safeFileName("../../a:b?.png"), "-a-b-.png");
});

test("export mime types cover packed note formats", () => {
  assert.equal(exportMimeType("md"), "text/markdown");
  assert.equal(exportMimeType("txt"), "text/plain");
  assert.equal(exportMimeType("docx"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(exportMimeType("pdf"), "application/pdf");
  const packed = encodeMultipart({ type: "file" }, [{ field: "media", fileName: "a.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF") }]);
  assert.match(packed.body.toString("latin1"), /filename="a.pdf"/);
  assert.match(packed.body.toString("latin1"), /%PDF/);
});

test("data URLs decode without a network request", () => {
  const result = decodeDataUrl("data:image/png;base64,aGVsbG8=", "photo.png");
  assert.equal(result.buffer.toString(), "hello");
  assert.equal(result.mimeType, "image/png");
});

test("limited response reader stops oversized payloads", async () => {
  const response = new Response(Buffer.from("12345"), { headers: { "content-length": "5" } });
  await assert.rejects(() => readLimitedBody(response, 4), /exceeds 4 bytes/);
});
