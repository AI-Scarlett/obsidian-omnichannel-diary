"use strict";

const dns = require("node:dns/promises");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const { assertSafeRemoteUrl, isPrivateHost, mimeExtension, safeFileName } = require("./util");

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/132 Safari/537.36 OmnichannelDiary/0.4";
const TRUSTED_SYNTHETIC_DNS_SUFFIXES = ["x.com", "twitter.com", "twimg.com", "weixin.qq.com", "qpic.cn", "qlogo.cn"];
const PUBLIC_DNS_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const publicDnsCache = new Map();

function isPrivateAddress(address) {
  return isPrivateHost(address);
}

function isTrustedSyntheticDnsUrl(input) {
  let parsed;
  try { parsed = input instanceof URL ? input : new URL(input); } catch (_) { return false; }
  if (parsed.protocol !== "https:") return false;
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  return TRUSTED_SYNTHETIC_DNS_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

function parsePublicDnsAnswer(payload) {
  return [...new Set((payload?.Answer || [])
    .map((answer) => String(answer?.data || "").trim())
    .filter((address) => net.isIP(address)))];
}

function queryPublicDns(hostname, type) {
  return new Promise((resolve, reject) => {
    const endpoint = `${PUBLIC_DNS_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=${encodeURIComponent(type)}`;
    const request = https.get(endpoint, {
      headers: { accept: "application/dns-json", "user-agent": USER_AGENT },
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Public DNS returned HTTP ${response.statusCode || 0}`));
        return;
      }
      response.setEncoding("utf8");
      let body = "";
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 64 * 1024) response.destroy(new Error("Public DNS response is too large"));
      });
      response.on("end", () => {
        try { resolve(parsePublicDnsAnswer(JSON.parse(body))); }
        catch (_) { reject(new Error("Public DNS returned invalid JSON")); }
      });
    });
    request.setTimeout(8_000, () => request.destroy(new Error("Public DNS request timed out")));
    request.once("error", reject);
  });
}

async function lookupPublicDns(hostname) {
  const cached = publicDnsCache.get(hostname);
  if (cached && cached.expiresAt > Date.now()) return cached.addresses;
  const settled = await Promise.allSettled([queryPublicDns(hostname, "A"), queryPublicDns(hostname, "AAAA")]);
  const addresses = [...new Set(settled.flatMap((result) => result.status === "fulfilled" ? result.value : []))];
  if (!addresses.length) throw new Error("Public DNS could not confirm a public address");
  publicDnsCache.set(hostname, { addresses, expiresAt: Date.now() + 5 * 60_000 });
  return addresses.map((address) => ({ address, family: net.isIP(address) }));
}

async function validateResolvedHost(url, options = {}) {
  const parsed = assertSafeRemoteUrl(url);
  const lookup = options.lookup || dns.lookup;
  const addresses = await lookup(parsed.hostname, { all: true, verbatim: true });
  const allowPrivateResolvedHost = isTrustedSyntheticDnsUrl(parsed)
    || (typeof options.allowPrivateResolvedHost === "function" && options.allowPrivateResolvedHost(parsed));
  if (!addresses.length) throw new Error("The address did not resolve");
  if (!allowPrivateResolvedHost && addresses.some(({ address }) => isPrivateAddress(address))) {
    let publicAddresses = [];
    try { publicAddresses = await (options.publicLookup || lookupPublicDns)(parsed.hostname); } catch (_) {}
    if (!publicAddresses.length || publicAddresses.some(({ address }) => isPrivateAddress(address))) {
      throw new Error("The address resolves to a local or private network");
    }
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

function responseHeaders(headers) {
  return {
    get(name) {
      const value = headers[String(name).toLowerCase()];
      return Array.isArray(value) ? value.join(", ") : value === undefined ? null : String(value);
    },
  };
}

function nodeRequest(input, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(input);
    const transport = url.protocol === "https:" ? https : http;
    const headers = { ...(options.headers || {}) };
    const hasContentLength = Object.keys(headers).some((name) => name.toLowerCase() === "content-length");
    if (options.body !== undefined && options.body !== null && !hasContentLength) {
      headers["content-length"] = String(Buffer.byteLength(options.body));
    }
    const request = transport.request(url, {
      method: options.method || "GET",
      headers,
      signal: options.signal,
    }, (incoming) => {
      const status = incoming.statusCode || 0;
      incoming.cancel = async () => incoming.destroy();
      resolve({
        status,
        ok: status >= 200 && status < 300,
        headers: responseHeaders(incoming.headers),
        body: incoming,
      });
    });
    request.once("error", reject);
    request.setTimeout(options.timeoutMs || 30_000, () => request.destroy(new Error("Request timed out")));
    if (options.body !== undefined && options.body !== null) request.write(options.body);
    request.end();
  });
}

function isRetryableTransportError(error) {
  return ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"].includes(error?.code)
    || /socket disconnected|timed? out|network connection was lost/i.test(error?.message || "");
}

async function requestWithRetry(input, options = {}, requester = nodeRequest) {
  const method = String(options.method || "GET").toUpperCase();
  const attempts = Math.max(1, Number(options.requestAttempts || (["GET", "HEAD"].includes(method) ? 3 : 1)));
  const delays = options.retryDelays || [0, 250, 700];
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, delays[Math.min(attempt, delays.length - 1)] || 0));
    try { return await requester(input, options); }
    catch (error) {
      lastError = error;
      if (!isRetryableTransportError(error) || attempt === attempts - 1) throw error;
    }
  }
  throw lastError || new Error("Request failed");
}

async function safeFetch(input, options = {}) {
  const validationOptions = { allowPrivateResolvedHost: options.allowPrivateResolvedHost, publicLookup: options.publicLookup };
  let url = (await validateResolvedHost(input, validationOptions)).toString();
  const maxRedirects = options.maxRedirects ?? 5;
  let method = options.method || "GET";
  let body = options.body;
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const response = await requestWithRetry(url, {
      method,
      headers: {
        "user-agent": USER_AGENT,
        accept: options.accept || "*/*",
        ...(options.headers || {}),
      },
      body,
      signal: options.signal || AbortSignal.timeout(options.timeoutMs || 30_000),
      timeoutMs: options.timeoutMs,
      requestAttempts: options.requestAttempts,
      retryDelays: options.retryDelays,
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`Redirect ${response.status} has no location`);
      await response.body?.cancel();
      url = (await validateResolvedHost(new URL(location, url).toString(), validationOptions)).toString();
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
      }
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

module.exports = { PUBLIC_DNS_ENDPOINT, TRUSTED_SYNTHETIC_DNS_SUFFIXES, USER_AGENT, decodeDataUrl, downloadRemoteFile, isRetryableTransportError, isTrustedSyntheticDnsUrl, lookupPublicDns, nodeRequest, parsePublicDnsAnswer, queryPublicDns, readLimitedBody, requestWithRetry, safeFetch, validateResolvedHost };
