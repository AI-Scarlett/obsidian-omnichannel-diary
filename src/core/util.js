"use strict";

const crypto = require("node:crypto");
const net = require("node:net");

function safeFileName(value, fallback = "item") {
  const cleaned = String(value || "").normalize("NFKC")
    .replace(/[\\/:*?"<>|#^[\]]/g, "-")
    .replace(/\.{2,}/g, "-")
    .replace(/-+/g, "-")
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ").replace(/^\.+|\.+$/g, "").trim().slice(0, 120);
  return cleaned || fallback;
}

function shortHash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
}

function localDateParts(input = new Date()) {
  const date = input instanceof Date ? input : new Date(input);
  const pad = (part) => String(part).padStart(2, "0");
  return {
    day: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
    iso: date.toISOString(),
  };
}

function extractUrls(text) {
  const matches = String(text || "").match(/https?:\/\/[^\s<>"'）)\]]+/gi) || [];
  return [...new Set(matches.map((url) => url.replace(/[.,;!?，。；！？]+$/, "")))];
}

function markdownEscape(value) {
  return String(value || "").replace(/([\\`*_{}[\]()<>#+\-.!|])/g, "\\$1");
}

function yamlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function isPrivateHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return true;
  const kind = net.isIP(host);
  if (kind === 4) {
    const parts = host.split(".").map(Number);
    return parts[0] === 10 || parts[0] === 127 || parts[0] === 0
      || (parts[0] === 169 && parts[1] === 254)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168) || parts[0] >= 224;
  }
  if (kind === 6) {
    return host === "::1" || host === "::" || host.startsWith("fc") || host.startsWith("fd")
      || host.startsWith("fe8") || host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb");
  }
  return false;
}

function assertSafeRemoteUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only HTTP(S) links are supported");
  if (isPrivateHost(url.hostname)) throw new Error("Local and private network addresses are blocked");
  return url;
}

function mimeExtension(mime, fallback = "bin") {
  const map = {
    "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp",
    "image/svg+xml": "svg", "image/avif": "avif", "application/pdf": "pdf",
    "audio/mpeg": "mp3", "audio/ogg": "ogg", "video/mp4": "mp4", "text/plain": "txt",
  };
  return map[String(mime || "").split(";")[0].toLowerCase()] || fallback;
}

function toErrorMessage(error) {
  return String(error?.message || error || "Unknown error");
}

module.exports = { assertSafeRemoteUrl, extractUrls, isPrivateHost, localDateParts, markdownEscape, mimeExtension, safeFileName, shortHash, toErrorMessage, yamlString };
