"use strict";

const dns = require("node:dns/promises");
const { assertSafeRemoteUrl, isPrivateHost, mimeExtension, safeFileName } = require("./util");

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/132 Safari/537.36 OmnichannelDiary/0.3";

function isPrivateAddress(address) {
  return isPrivateHost(address);
}

async function validateResolvedHost(url) {
  const parsed = assertSafeRemoteUrl(url);
  const addresses = await dns.lookup(parsed.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("The address resolves to a local or private network");
  }
  return parsed;
}

async function readLimitedBody(response, maxBytes) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) throw new Error(`Remote file exceeds ${maxBytes} bytes`);
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    const value = Buffer.from(chunk);
    size += value.length;
    if (size > maxBytes) throw new Error(`Remote file exceeds ${maxBytes} bytes`);
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function safeFetch(input, options = {}) {
  let url = (await validateResolvedHost(input)).toString();
  const maxRedirects = options.maxRedirects ?? 5;
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: {
        "user-agent": USER_AGENT,
        accept: options.accept || "*/*",
        ...(options.headers || {}),
      },
      body: options.body,
      signal: options.signal || AbortSignal.timeout(options.timeoutMs || 30_000),
      redirect: "manual",
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`Redirect ${response.status} has no location`);
      url = (await validateResolvedHost(new URL(location, url).toString())).toString();
      continue;
    }
    return { response, finalUrl: url };
  }
  throw new Error("Too many redirects");
}

async function downloadRemoteFile(url, options = {}) {
  if (String(url).startsWith("data:")) return decodeDataUrl(url, options.fileName);
  const headers = { ...(options.headers || {}) };
  if (options.referrer) headers.referer = options.referrer;
  let result;
  const retryable = new Set([429, 500, 502, 503, 504]);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    result = await safeFetch(url, { headers, timeoutMs: options.timeoutMs, accept: options.accept || "image/avif,image/webp,image/*,*/*;q=0.8" });
    if (result.response.ok) break;
    if (attempt === 0 && headers.referer) delete headers.referer;
    if (!retryable.has(result.response.status) || attempt === 3) break;
    try { await result.response.body?.cancel(); } catch (_) {}
    const retryAfter = Number(result.response.headers.get("retry-after") || 0);
    const waitMs = retryAfter > 0 ? Math.min(10_000, retryAfter * 1000) : 700 * (2 ** attempt);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  if (!result.response.ok) throw new Error(`Download failed with HTTP ${result.response.status}`);
  const mimeType = (result.response.headers.get("content-type") || options.mimeType || "application/octet-stream").split(";")[0];
  const buffer = await readLimitedBody(result.response, options.maxBytes || 20 * 1024 * 1024);
  const pathName = new URL(result.finalUrl).pathname;
  const remoteName = decodeURIComponent(pathName.slice(pathName.lastIndexOf("/") + 1));
  const fileName = safeFileName(options.fileName || remoteName, `attachment.${mimeExtension(mimeType)}`);
  return { buffer, mimeType, fileName, finalUrl: result.finalUrl };
}

function decodeDataUrl(value, requestedName) {
  const match = String(value).match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/i);
  if (!match) throw new Error("Invalid data URL");
  const mimeType = match[1] || "application/octet-stream";
  const buffer = match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3]), "utf8");
  return {
    buffer,
    mimeType,
    fileName: safeFileName(requestedName, `embedded.${mimeExtension(mimeType)}`),
    finalUrl: "data:",
  };
}

module.exports = { USER_AGENT, decodeDataUrl, downloadRemoteFile, readLimitedBody, safeFetch, validateResolvedHost };
