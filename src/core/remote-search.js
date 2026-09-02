"use strict";

const crypto = require("node:crypto");
const { exportMimeType, localDateParts, yamlString } = require("./util");
const { translate } = require("./i18n");

const REMOTE_QUERY_MAX_RESULTS = 10;
const REMOTE_QUERY_MAX_ACTIVE = 5;
const REMOTE_QUERY_TTL_MS = 2 * 60 * 60 * 1000;
const REMOTE_SEARCH_MAX_FILE_BYTES = 5 * 1024 * 1024;
const REMOTE_EXPORT_MAX_NOTES = 20;
const REMOTE_EXPORT_MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const REMOTE_EXPORT_MAX_FILE_BYTES = 20 * 1024 * 1024;
const REMOTE_PDF_MAX_CHARS = 200000;
const REMOTE_EXPORT_SOURCE = "omnichannel-diary-remote-export";

const REMOTE_EXPORT_FORMATS = {
  md: { zh: "Markdown (.md)", en: "Markdown (.md)" },
  txt: { zh: "纯文本 (.txt)", en: "Plain text (.txt)" },
  docx: { zh: "Word (.docx)", en: "Word (.docx)" },
  pdf: { zh: "PDF (.pdf)", en: "PDF (.pdf)" },
};

function remoteExportFormat(settings) {
  const value = String(settings?.remoteSearch?.exportFormat || "md").toLowerCase();
  return Object.prototype.hasOwnProperty.call(REMOTE_EXPORT_FORMATS, value) ? value : "md";
}

function remoteExportFormatLabel(settings, locale = "zh-CN") {
  const format = remoteExportFormat(settings);
  return REMOTE_EXPORT_FORMATS[format][locale === "en" ? "en" : "zh"];
}

function sanitizeSearchFolder(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\.{2,}/g, ".").trim();
}

function ownerKey(channel, senderId) {
  return `${String(channel || "unknown")}:${String(senderId || "")}`;
}

function sanitizeRemoteQueries(list) {
  const now = Date.now();
  if (!Array.isArray(list)) return [];
  return list
    .filter((item) => item && typeof item.id === "string" && Number(item.expiresAt) > now)
    .map((item) => ({
      id: String(item.id),
      ownerKey: String(item.ownerKey || ownerKey(item.channel, item.senderId)),
      channel: String(item.channel || ""),
      senderId: String(item.senderId || ""),
      keyword: String(item.keyword || "").slice(0, 100),
      createdAt: Number(item.createdAt) || now,
      expiresAt: Number(item.expiresAt) || now,
      candidates: Array.isArray(item.candidates)
        ? item.candidates.slice(0, REMOTE_QUERY_MAX_RESULTS).map((candidate) => ({
          path: String(candidate?.path || ""),
          title: String(candidate?.title || "").slice(0, 160),
          time: String(candidate?.time || "").slice(0, 80),
          source: String(candidate?.source || "").slice(0, 240),
          mtime: Number(candidate?.mtime) || 0,
        })).filter((candidate) => candidate.path)
        : [],
    }))
    .filter((item) => item.candidates.length)
    .slice(-REMOTE_QUERY_MAX_ACTIVE);
}

function normalizeRemoteSearchSettings(settings) {
  if (!settings.remoteSearch || typeof settings.remoteSearch !== "object") {
    settings.remoteSearch = { enabled: false, folder: "", exportFormat: "md" };
  }
  if (!settings.runtime || typeof settings.runtime !== "object") settings.runtime = {};
  settings.remoteSearch.enabled = settings.remoteSearch.enabled === true;
  settings.remoteSearch.folder = sanitizeSearchFolder(settings.remoteSearch.folder);
  settings.remoteSearch.exportFormat = remoteExportFormat(settings);
  settings.runtime.remoteQueries = sanitizeRemoteQueries(settings.runtime.remoteQueries);
  return settings;
}

function normalizeRemoteText(value) {
  return String(value == null ? "" : value).normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function parseRemoteIndexes(raw) {
  const value = String(raw || "").normalize("NFKC").replace(/[，、]/g, ",").trim();
  if (!/^[0-9,\s-]+$/.test(value)) return null;
  const out = new Set();
  for (const part0 of value.split(/[\s,]+/)) {
    const part = part0.trim();
    if (!part) continue;
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start < 1 || end < start || end - start > REMOTE_EXPORT_MAX_NOTES) return null;
      for (let n = start; n <= end; n += 1) out.add(n);
    } else {
      const n = Number(part);
      if (!Number.isInteger(n) || n < 1) return null;
      out.add(n);
    }
  }
  return out.size ? [...out].sort((a, b) => a - b) : null;
}

function detectRemoteCommandLocale(text) {
  const value = String(text || "");
  if (/[A-Za-z]/.test(value) && !/[\u4e00-\u9fff]/.test(value)) return "en";
  if (/[A-Za-z]/.test(value) && /(?:search|query|find|lookup|confirm|export|cancel|help)\b/i.test(value)) return "en";
  return "zh-CN";
}

function feishuPostPlainText(value) {
  if (!value) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try { return feishuPostPlainText(JSON.parse(trimmed)); } catch (_) { return value; }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(feishuPostPlainText).filter(Boolean).join(" ");
  if (typeof value === "object") {
    const tag = String(value.tag || "").toLowerCase();
    if (["at", "img", "emotion", "media", "sticker"].includes(tag)) return "";
    if (typeof value.text === "string") return value.text;
    const preferred = [value.content, value.title, value.zh_cn, value.en_us, value.post];
    for (const item of preferred) {
      if (item == null) continue;
      const extracted = feishuPostPlainText(item);
      if (extracted) return extracted;
    }
    const skip = new Set(["tag", "user_id", "user_name", "style", "href", "image_key", "file_key", "mention_type"]);
    return Object.entries(value)
      .filter(([key]) => !skip.has(key))
      .map(([, item]) => feishuPostPlainText(item))
      .filter(Boolean)
      .join(" ");
  }
  return String(value);
}

function stripRemoteCommandNoise(raw) {
  let text = feishuPostPlainText(raw);
  text = String(text || "").replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ").replace(/\u3000/g, " ");
  text = text.replace(/<at[^>]*>[\s\S]*?<\/at>/gi, " ");
  text = text.replace(/<@!?[^>\s]+(?:\|[^>]+)?>/g, " ");
  text = text.replace(/@_user_\d+(?:@\S+)?/gi, " ");
  text = text.replace(/@all\b/gi, " ");
  text = text.replace(/@[^\s@]+/g, " ");
  text = text.replace(/^\s*[/／]\s*(?:help|status|clip)\b/i, (match) => match.replace(/[／]/g, "/"));
  return text.replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
}

function parseOneRemoteCommand(text) {
  if (!text) return null;
  const locale = detectRemoteCommandLocale(text);
  if (/^(?:查询|搜索|检索|查詢|搜尋)帮助$/.test(text)
    || /^(?:查询|搜索|检索|查詢|搜尋)\s+帮助$/.test(text)
    || /^(?:search|query|find|lookup)\s+help$/i.test(text)
    || /^(?:remote|search)\s+help$/i.test(text)) {
    return { type: "help", locale };
  }
  if (/^取消(?:查询|搜索|检索|查詢|搜尋)?$/.test(text) || /^cancel(?:\s+(?:search|query|find|lookup))?$/i.test(text)) {
    return { type: "cancel", locale };
  }
  let match = /^(?:查|查询|搜索|检索|查詢|搜尋)(?:\s+|[:：]\s*)(.+)$/.exec(text);
  if (!match) match = /^(?:search|query|find|lookup)(?:\s+|:\s*)(.+)$/i.exec(text);
  if (match) {
    const keyword = match[1].trim();
    if (keyword) return { type: "search", keyword, locale };
  }
  match = /^(?:确认|確認|导出|匯出|confirm|export)\s*(?:(Q\d{4}-[0-9A-F]{4})\s+)?(.+)$/i.exec(text);
  if (match) {
    const indexes = parseRemoteIndexes(match[2]);
    if (indexes) return { type: "export", queryId: match[1] ? match[1].toUpperCase() : "", indexes, rawIndexes: match[2], locale };
  }
  return null;
}

function parseRemoteCommand(raw) {
  const cleaned = stripRemoteCommandNoise(raw).normalize("NFKC").trim();
  if (!cleaned) return null;
  const lines = cleaned.split("\n").map((line) => line.trim()).filter(Boolean);
  const candidates = [cleaned, ...lines.filter((line) => line !== cleaned)];
  for (const candidate of candidates) {
    const parsed = parseOneRemoteCommand(candidate);
    if (parsed) return parsed;
  }
  return null;
}

function formatRemoteHelpText(settings = {}, locale = "zh-CN") {
  const label = remoteExportFormatLabel(settings, locale);
  return locale === "en" ? [
    "Remote search:",
    "• There MUST be a space after the command. Example: search keyword",
    "• Without that space, the message is saved as a normal diary line. Example: searchkeyword is not a query.",
    "• search keyword / query keyword / find keyword / lookup keyword: return title, time, source, and path",
    "• Chinese: 查 关键词 — space required. 查手机卡 is saved as diary text, not a search.",
    "• confirm 1,3: pack those items using the computer's default format",
    "• export Q0902-ABCD 1-3: pack a specific query",
    "• cancel search: clear pending results",
    "",
    `Export format is set on the computer and is currently ${label}. Do not choose a format in chat.`,
    "Search and packing are built into this plugin. After confirmation, the plugin tries to send an openable file through the current channel.",
  ].join("\n") : [
    "远程查询用法：",
    "· 命令和关键词之间必须有空格。正确：查 关键词；错误：查手机卡（会当作普通日记记下来）",
    "· 也可用：查询 关键词 / 搜索 关键词 / 查詢 關鍵詞 / search keyword / find keyword",
    "· 查 关键词 → 返回标题、时间、来源和路径",
    "· 确认 1,3 / 確認 1,3 / confirm 1,3 → 导出最近一次查询的第 1、3 条",
    "· 导出 Q0902-ABCD 1-3 / export Q0902-ABCD 1-3 → 导出指定查询",
    "· 取消查询 / cancel search → 清空待确认结果",
    "",
    `导出格式由电脑端设置，当前是 ${label}，聊天里不用再写格式。`,
    "查询和打包已内置在本插件中。确认后会尝试把可打开的附件发回当前渠道。",
  ].join("\n");
}

function formatRemoteDisabledText(locale = "zh-CN") {
  return translate(locale,
    "远程查询默认关闭。请在电脑端 Obsidian 设置 → 第三方插件 → Omnichannel Diary → 收集规则 → 远程查询与导出 中打开。",
    "Remote search is off by default. Enable it in Obsidian Settings → Community plugins → Omnichannel Diary → Capture rules → Remote search and export.");
}

function formatRemoteCancelText(locale = "zh-CN") {
  return translate(locale, "已取消待确认的查询。", "Cancelled the pending search.");
}

function formatRemoteAckText(kind, locale = "zh-CN") {
  if (kind === "export") {
    return translate(locale, "正在打包并发送附件，请稍等！", "Packing the notes and sending the file. Please wait.");
  }
  return translate(locale, "正在查询，请稍等！", "Searching your notes. Please wait.");
}

function formatRemoteExportReceipt(file, channelName, locale = "zh-CN", status = "unsupported", error = "") {
  const name = file?.name || "";
  const count = Number(file?.count) || 0;
  if (status === "sent") {
    return locale === "en"
      ? `Packed ${count} note${count === 1 ? "" : "s"} as ${name} and sent an openable file through ${channelName}. If it does not appear as an attachment, check the chat for a document message.`
      : `已按电脑端默认格式打包 ${count} 条笔记（${name}），并已通过${channelName}发送可打开的附件。若聊天里没有附件气泡，请下拉查看是否被折叠。`;
  }
  if (status === "failed") {
    const detail = String(error || "").trim();
    return locale === "en"
      ? `Packed ${count} note${count === 1 ? "" : "s"} as ${name} on the computer, but ${channelName} could not send an openable file${detail ? `: ${detail}` : "."}`
      : `已按电脑端默认格式打包 ${count} 条笔记（${name}），但${channelName}未能发送可打开的附件${detail ? `：${detail}` : "。"}`;
  }
  return locale === "en"
    ? `Packed ${count} note${count === 1 ? "" : "s"} on the computer as ${name}. File sending is not connected for ${channelName} yet, so this is a text receipt only.`
    : `已按电脑端默认格式打包 ${count} 条笔记（${name}）。${channelName} 发附件尚未接通，文件已在电脑生成，当前只发送这条文字回执。`;
}

function remoteDateValue(value, fallbackMs) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const parts = localDateParts(value);
    return `${parts.day} ${parts.time}`;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      const parts = localDateParts(date);
      return `${parts.day} ${parts.time}`;
    }
  }
  const raw = Array.isArray(value) ? value.join(", ") : String(value == null ? "" : value).trim();
  if (raw) return raw.replace("T", " ").slice(0, 40);
  const parts = localDateParts(new Date(Number(fallbackMs) || Date.now()));
  return `${parts.day} ${parts.time}`;
}

function remoteFrontmatterValue(frontmatter, keys) {
  const data = frontmatter && typeof frontmatter === "object" ? frontmatter : {};
  for (const key of keys) {
    if (data[key] != null && String(data[key]).trim()) return data[key];
  }
  return "";
}

function remoteStringValue(value) {
  if (Array.isArray(value)) return value.map(remoteStringValue).filter(Boolean).join(", ");
  if (value && typeof value === "object") {
    try { return JSON.stringify(value); } catch (_) { return String(value); }
  }
  return String(value == null ? "" : value);
}

function stripRemoteFrontmatter(markdown) {
  const value = String(markdown || "").replace(/\r\n?/g, "\n");
  if (!value.startsWith("---\n")) return value;
  const end = value.indexOf("\n---\n", 4);
  return end >= 0 ? value.slice(end + 5) : value;
}

function markdownToRemotePlainText(markdown) {
  return stripRemoteFrontmatter(markdown)
    .replace(/!\[\[([^\]]+)\]\]/g, "[附件: $1]")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "[图片: $1 $2]")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/^```[^\n]*\n?/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\r\n?/g, "\n")
    .trim();
}

function composeRemoteMarkdown(notes, info) {
  const lines = [
    "---",
    `source: ${REMOTE_EXPORT_SOURCE}`,
    `query: ${yamlString(info.keyword || "")}`,
    `exported_at: ${yamlString(new Date().toISOString())}`,
    `note_count: ${notes.length}`,
    "---",
    "",
    "# Obsidian 笔记导出",
    "",
    `查询关键词：${info.keyword || ""}`,
  ];
  notes.forEach((note, index) => {
    lines.push("", "---", "", `## ${index + 1}. ${note.title}`, "",
      `- 原文件：\`${String(note.path || "").replace(/`/g, "\\`")}\``,
      `- 时间：${note.time}`,
      `- 来源：${note.source}`,
      "", String(note.content || "").trim());
  });
  return `${lines.join("\n").trim()}\n`;
}

function composeRemotePlainText(notes, info, pageBreak) {
  const out = ["Obsidian 笔记导出", `查询关键词：${info.keyword || ""}`, `笔记数量：${notes.length}`, ""];
  notes.forEach((note, index) => {
    if (index && pageBreak) out.push(pageBreak);
    out.push("=".repeat(48), `${index + 1}. ${note.title}`,
      `原文件：${note.path}`, `时间：${note.time}`, `来源：${note.source}`, "-".repeat(48),
      markdownToRemotePlainText(note.content), "");
  });
  return `${out.join("\n").trim()}\n`;
}

function remoteXmlEscape(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

let remoteCrcTable = null;
function remoteCrc32(buf) {
  if (!remoteCrcTable) {
    remoteCrcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let crc = n;
      for (let k = 0; k < 8; k += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
      remoteCrcTable[n] = crc >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = remoteCrcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function remoteZipDosDate(date) {
  const value = date || new Date();
  return {
    time: ((value.getHours() & 31) << 11) | ((value.getMinutes() & 63) << 5) | ((Math.floor(value.getSeconds() / 2)) & 31),
    date: (((Math.max(1980, value.getFullYear()) - 1980) & 127) << 9) | (((value.getMonth() + 1) & 15) << 5) | (value.getDate() & 31),
  };
}

function buildRemoteStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const dt = remoteZipDosDate(new Date());
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
    const crc = remoteCrc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8); local.writeUInt16LE(dt.time, 10); local.writeUInt16LE(dt.date, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(0, 10); central.writeUInt16LE(dt.time, 12); central.writeUInt16LE(dt.date, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralBuf = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralBuf, end]);
}

function buildRemoteDocx(text, title) {
  const paragraphs = String(text || "").replace(/\r\n?/g, "\n").split("\n").map((line, index) => {
    if (line === "\f") return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
    const style = index === 0 ? '<w:pPr><w:pStyle w:val="Title"/></w:pPr>' : "";
    return `<w:p>${style}<w:r><w:t xml:space="preserve">${remoteXmlEscape(line)}</w:t></w:r></w:p>`;
  }).join("");
  const documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + paragraphs
    + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>';
  const stylesXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Microsoft YaHei"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>'
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style></w:styles>';
  const now = new Date().toISOString();
  const entries = [
    { name: "[Content_Types].xml", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>' },
    { name: "_rels/.rels", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>' },
    { name: "word/document.xml", data: documentXml },
    { name: "word/styles.xml", data: stylesXml },
    { name: "word/_rels/document.xml.rels", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
    { name: "docProps/core.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${remoteXmlEscape(title || "Obsidian 笔记导出")}</dc:title><dc:creator>Omnichannel Diary</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created></cp:coreProperties>` },
    { name: "docProps/app.xml", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Omnichannel Diary</Application></Properties>' },
  ];
  return buildRemoteStoredZip(entries);
}

function buildRemotePdfFromJpegs(pages) {
  if (!Array.isArray(pages) || !pages.length) throw new Error("PDF 没有可写入的页面");
  const chunks = [];
  const offsets = [0];
  let length = 0;
  const push = (value) => {
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "binary");
    chunks.push(buf);
    length += buf.length;
  };
  push(Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "binary"));
  const objectCount = 2 + pages.length * 3;
  const kids = pages.map((_, index) => `${3 + index * 3} 0 R`).join(" ");
  const writeObject = (n, bodyParts) => {
    offsets[n] = length;
    push(`${n} 0 obj\n`);
    for (const part of bodyParts) push(part);
    push("\nendobj\n");
  };
  writeObject(1, ["<< /Type /Catalog /Pages 2 0 R >>"]);
  writeObject(2, [`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`]);
  pages.forEach((page, index) => {
    const pageObj = 3 + index * 3;
    const imageObj = pageObj + 1;
    const contentObj = pageObj + 2;
    const imageName = `Im${index + 1}`;
    const jpeg = Buffer.isBuffer(page.jpeg) ? page.jpeg : Buffer.from(page.jpeg);
    const content = Buffer.from(`q\n595.28 0 0 841.89 0 0 cm\n/${imageName} Do\nQ\n`, "ascii");
    writeObject(pageObj, [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /XObject << /${imageName} ${imageObj} 0 R >> >> /Contents ${contentObj} 0 R >>`]);
    writeObject(imageObj, [`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, jpeg, "\nendstream"]);
    writeObject(contentObj, [`<< /Length ${content.length} >>\nstream\n`, content, "endstream"]);
  });
  const xrefOffset = length;
  push(`xref\n0 ${objectCount + 1}\n`);
  push("0000000000 65535 f \n");
  for (let i = 1; i <= objectCount; i += 1) push(`${String(offsets[i] || 0).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return Buffer.concat(chunks);
}

function remoteWrapCanvasText(ctx, text, maxWidth) {
  const chars = [...String(text || "")];
  if (!chars.length) return [""];
  const lines = [];
  let pos = 0;
  while (pos < chars.length) {
    let lo = 1;
    let hi = Math.min(240, chars.length - pos);
    let fit = 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ctx.measureText(chars.slice(pos, pos + mid).join("")).width <= maxWidth) {
        fit = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (pos + fit < chars.length) {
      const segment = chars.slice(pos, pos + fit).join("");
      const ws = Math.max(segment.lastIndexOf(" "), segment.lastIndexOf("\t"));
      if (ws >= Math.floor(fit * 0.6)) fit = ws + 1;
    }
    lines.push(chars.slice(pos, pos + fit).join("").trimEnd());
    pos += fit;
    while (pos < chars.length && (chars[pos] === " " || chars[pos] === "\t")) pos += 1;
  }
  return lines;
}

async function renderRemotePdf(text) {
  if (typeof document === "undefined" || !document.createElement) {
    throw new Error("当前桌面环境不支持 PDF Canvas，请在电脑端把默认导出格式改为 MD、TXT 或 DOCX");
  }
  if ([...String(text || "")].length > REMOTE_PDF_MAX_CHARS) {
    throw new Error("PDF 正文超过 20 万字，请改用 MD/TXT/DOCX 或减少笔记数量");
  }
  const width = 1240;
  const height = 1754;
  const marginX = 92;
  const top = 112;
  const bottom = 92;
  const lineHeight = 42;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext && canvas.getContext("2d");
  if (!ctx || typeof canvas.toDataURL !== "function") throw new Error("当前桌面环境无法创建 PDF 页面，请改用 MD/TXT/DOCX");
  ctx.font = '26px -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif';
  const allPages = [[]];
  const newPage = () => { if (allPages[allPages.length - 1].length) allPages.push([]); };
  for (const paragraph of String(text || "").replace(/\r\n?/g, "\n").split("\n")) {
    if (paragraph === "\f") {
      newPage();
      continue;
    }
    const wrapped = remoteWrapCanvasText(ctx, paragraph, width - marginX * 2);
    for (const line of wrapped) {
      const page = allPages[allPages.length - 1];
      if (page.length >= Math.floor((height - top - bottom) / lineHeight)) allPages.push([]);
      allPages[allPages.length - 1].push(line);
    }
  }
  const pages = [];
  for (let p = 0; p < allPages.length; p += 1) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#111111";
    ctx.font = '26px -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif';
    let y = top;
    for (const line of allPages[p]) {
      ctx.fillText(line, marginX, y);
      y += lineHeight;
    }
    ctx.fillStyle = "#777777";
    ctx.font = '20px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText(`Omnichannel Diary · ${p + 1} / ${allPages.length}`, width - 360, height - 45);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.88);
    pages.push({ width, height, jpeg: Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64") });
  }
  return buildRemotePdfFromJpegs(pages);
}

function safeRemoteExportFilename(keyword, format) {
  const safe = String(keyword || "笔记").replace(/[\\/:*?"<>|\x00-\x1f]/g, "-").replace(/\s+/g, " ").trim().slice(0, 40) || "笔记";
  const parts = localDateParts();
  const stamp = `${parts.day.replace(/-/g, "")}-${parts.time.replace(":", "")}`;
  return `Obsidian-${safe}-${stamp}.${format}`;
}

function newQueryId() {
  const mmdd = localDateParts().day.slice(5).replace("-", "");
  return `Q${mmdd}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
}

class RemoteSearchService {
  constructor(options = {}) {
    this.getVault = options.getVault || (() => null);
    this.getMetadataCache = options.getMetadataCache || (() => null);
    this.getSettings = options.getSettings || (() => ({
      remoteSearch: { enabled: false, folder: "", exportFormat: "md" },
      runtime: { remoteQueries: [] },
    }));
    this.persist = options.persist || (async () => {});
  }

  _settings() {
    return this.getSettings();
  }

  _sessions() {
    const settings = this._settings();
    if (!settings.runtime || typeof settings.runtime !== "object") settings.runtime = { remoteQueries: [] };
    settings.runtime.remoteQueries = sanitizeRemoteQueries(settings.runtime.remoteQueries);
    return settings.runtime.remoteQueries;
  }

  clearAll() {
    const settings = this._settings();
    if (!settings.runtime) settings.runtime = {};
    settings.runtime.remoteQueries = [];
  }

  clearOwner(channel, senderId) {
    const key = ownerKey(channel, senderId);
    const sessions = this._sessions();
    for (let i = sessions.length - 1; i >= 0; i -= 1) {
      if (sessions[i].ownerKey === key) sessions.splice(i, 1);
    }
  }

  _replaceOwnerSession(session) {
    const sessions = this._sessions();
    for (let i = sessions.length - 1; i >= 0; i -= 1) {
      if (sessions[i].ownerKey === session.ownerKey) sessions.splice(i, 1);
    }
    sessions.push(session);
    if (sessions.length > REMOTE_QUERY_MAX_ACTIVE) sessions.splice(0, sessions.length - REMOTE_QUERY_MAX_ACTIVE);
  }

  _fileMetadata(file) {
    const cache = this.getMetadataCache()?.getFileCache?.(file) || null;
    const frontmatter = (cache && cache.frontmatter) || {};
    const title = remoteStringValue(remoteFrontmatterValue(frontmatter, ["title", "name"])) || file.basename || file.name || file.path;
    const time = remoteDateValue(remoteFrontmatterValue(frontmatter, ["date", "created", "created_at", "published", "updated", "modified"]), file.stat && file.stat.mtime);
    const source = remoteStringValue(remoteFrontmatterValue(frontmatter, ["source", "url", "origin", "original_url", "canonical_url"])) || "本地笔记";
    const aliases = remoteStringValue(remoteFrontmatterValue(frontmatter, ["aliases", "alias"]));
    const tags = [remoteStringValue(frontmatter.tags), ...(((cache && cache.tags) || []).map((tag) => tag && tag.tag || ""))].filter(Boolean).join(" ");
    return {
      title: String(title).slice(0, 160),
      time: String(time).slice(0, 80),
      source: String(source).slice(0, 240),
      aliases,
      tags,
      frontmatter: remoteStringValue(frontmatter),
    };
  }

  async search(keyword, owner = {}) {
    const query = String(keyword || "").trim();
    if ([...query].length < 1 || [...query].length > 100) throw new Error("关键词长度应为 1–100 个字符");
    const terms = normalizeRemoteText(query).split(" ").filter(Boolean);
    const phrase = normalizeRemoteText(query);
    const vault = this.getVault();
    if (!vault || typeof vault.getMarkdownFiles !== "function") throw new Error("当前 Vault 无法搜索 Markdown 笔记");
    let files = vault.getMarkdownFiles() || [];
    const folder = sanitizeSearchFolder(this._settings()?.remoteSearch?.folder);
    if (folder) files = files.filter((file) => file.path && file.path.startsWith(`${folder}/`));
    const hits = [];
    const evaluate = async (file) => {
      const meta = this._fileMetadata(file);
      let content = "";
      if (!file.stat || !file.stat.size || file.stat.size <= REMOTE_SEARCH_MAX_FILE_BYTES) {
        try { content = await vault.cachedRead(file); } catch (_) { content = ""; }
      }
      const title = normalizeRemoteText(meta.title);
      const aliases = normalizeRemoteText(meta.aliases);
      const tags = normalizeRemoteText(meta.tags);
      const frontmatter = normalizeRemoteText(meta.frontmatter);
      const body = normalizeRemoteText(content);
      const haystack = [title, aliases, tags, frontmatter, body].join("\n");
      if (!terms.every((term) => haystack.includes(term))) return;
      let score = 0;
      if (title === phrase) score += 160;
      else if (title.includes(phrase)) score += 100;
      if (aliases.includes(phrase)) score += 60;
      if (tags.includes(phrase)) score += 45;
      if (frontmatter.includes(phrase)) score += 25;
      if (body.includes(phrase)) score += 20;
      for (const term of terms) {
        if (title.includes(term)) score += 25;
        if (aliases.includes(term)) score += 12;
        if (tags.includes(term)) score += 10;
        if (body.includes(term)) score += 3;
      }
      hits.push({
        path: file.path,
        title: meta.title,
        time: meta.time,
        source: meta.source,
        mtime: Number(file.stat && file.stat.mtime) || 0,
        score,
      });
    };
    for (let i = 0; i < files.length; i += 12) {
      await Promise.all(files.slice(i, i + 12).map(evaluate));
    }
    hits.sort((a, b) => b.score - a.score || b.mtime - a.mtime || String(a.path).localeCompare(String(b.path)));
    const candidates = hits.slice(0, REMOTE_QUERY_MAX_RESULTS).map(({ score, ...rest }) => rest);
    if (!candidates.length) {
      return { replyZh: `没有找到包含「${query}」的 Markdown 笔记。`, replyEn: `No Markdown notes containing “${query}” were found.`, session: null };
    }
    const session = {
      id: newQueryId(),
      ownerKey: ownerKey(owner.channel, owner.senderId),
      channel: String(owner.channel || ""),
      senderId: String(owner.senderId || ""),
      keyword: query,
      createdAt: Date.now(),
      expiresAt: Date.now() + REMOTE_QUERY_TTL_MS,
      candidates,
    };
    this._replaceOwnerSession(session);
    await this.persist();
    const linesZh = [`查询 ${session.id}：找到 ${candidates.length} 条（最多显示 ${REMOTE_QUERY_MAX_RESULTS} 条）`];
    const linesEn = [`Query ${session.id}: found ${candidates.length} note${candidates.length === 1 ? "" : "s"} (showing up to ${REMOTE_QUERY_MAX_RESULTS})`];
    candidates.forEach((candidate, index) => {
      linesZh.push("", `${index + 1}. ${candidate.title}`, `时间：${candidate.time}`, `来源：${candidate.source}`, `路径：${candidate.path}`);
      linesEn.push("", `${index + 1}. ${candidate.title}`, `Time: ${candidate.time}`, `Source: ${candidate.source}`, `Path: ${candidate.path}`);
    });
    const formatZh = remoteExportFormatLabel(this._settings(), "zh-CN");
    const formatEn = remoteExportFormatLabel(this._settings(), "en");
    linesZh.push("", `确认后回复：确认 ${session.id} 1,3`, "也可直接回复：确认 1,3", `格式由电脑端设置，当前为 ${formatZh}。`);
    linesEn.push("", `To confirm, reply: confirm ${session.id} 1,3`, "Or reply: confirm 1,3", `Export format is set on the computer and is currently ${formatEn}.`);
    return { replyZh: linesZh.join("\n"), replyEn: linesEn.join("\n"), session };
  }

  _findSession(queryId, owner = {}) {
    const key = ownerKey(owner.channel, owner.senderId);
    const sessions = this._sessions().filter((item) => item.ownerKey === key);
    if (!sessions.length) return null;
    if (!queryId) return sessions[sessions.length - 1];
    return sessions.find((item) => item.id === String(queryId).toUpperCase()) || null;
  }

  async createExport(queryId, indexes, owner = {}) {
    const session = this._findSession(queryId, owner);
    if (!session) throw new Error("查询已过期或不存在，请重新发送“查 关键词”");
    if (!indexes || !indexes.length) throw new Error(`请回复要导出的编号，例如：确认 ${session.id} 1,3`);
    if (indexes.length > REMOTE_EXPORT_MAX_NOTES) throw new Error(`一次最多导出 ${REMOTE_EXPORT_MAX_NOTES} 条笔记`);
    const invalid = indexes.filter((n) => n < 1 || n > session.candidates.length);
    if (invalid.length) throw new Error(`编号超出范围：${invalid.join(",")}；本次只有 ${session.candidates.length} 条`);
    const vault = this.getVault();
    if (!vault) throw new Error("当前 Vault 无法读取笔记");
    const notes = [];
    let sourceBytes = 0;
    for (const n of indexes) {
      const candidate = session.candidates[n - 1];
      const file = vault.getFileByPath?.(candidate.path) || vault.getAbstractFileByPath?.(candidate.path);
      if (!file) throw new Error(`第 ${n} 条笔记已被删除，请重新查询`);
      const currentMtime = Number(file.stat && file.stat.mtime) || 0;
      if (candidate.mtime && currentMtime && candidate.mtime !== currentMtime) {
        throw new Error(`第 ${n} 条笔记在查询后发生了修改，请重新查询确认`);
      }
      const content = await vault.cachedRead(file);
      sourceBytes += Buffer.byteLength(content, "utf8");
      if (sourceBytes > REMOTE_EXPORT_MAX_SOURCE_BYTES) throw new Error("所选笔记正文合计超过 5MB，请减少数量后重试");
      notes.push({ ...candidate, content });
    }
    const format = remoteExportFormat(this._settings());
    const info = { keyword: session.keyword, queryId: session.id };
    let buffer;
    if (format === "md") buffer = Buffer.from(composeRemoteMarkdown(notes, info), "utf8");
    else if (format === "txt") buffer = Buffer.from(composeRemotePlainText(notes, info, ""), "utf8");
    else if (format === "docx") buffer = buildRemoteDocx(composeRemotePlainText(notes, info, "\f"), "Obsidian 笔记导出");
    else buffer = await renderRemotePdf(composeRemotePlainText(notes, info, "\f"));
    if (!buffer.length || buffer.length > REMOTE_EXPORT_MAX_FILE_BYTES) throw new Error("导出文件超过 20MB，请减少笔记数量或改用 MD/TXT");
    const name = safeRemoteExportFilename(session.keyword, format);
    return {
      name,
      buffer,
      format,
      mimeType: exportMimeType(format, name),
      queryId: session.id,
      count: notes.length,
    };
  }
}

module.exports = {
  REMOTE_EXPORT_FORMATS,
  REMOTE_EXPORT_SOURCE,
  REMOTE_QUERY_MAX_ACTIVE,
  REMOTE_QUERY_MAX_RESULTS,
  RemoteSearchService,
  buildRemoteDocx,
  buildRemotePdfFromJpegs,
  buildRemoteStoredZip,
  composeRemoteMarkdown,
  composeRemotePlainText,
  detectRemoteCommandLocale,
  formatRemoteAckText,
  formatRemoteCancelText,
  formatRemoteDisabledText,
  formatRemoteExportReceipt,
  formatRemoteHelpText,
  markdownToRemotePlainText,
  normalizeRemoteSearchSettings,
  ownerKey,
  parseRemoteCommand,
  parseRemoteIndexes,
  stripRemoteCommandNoise,
  remoteExportFormat,
  remoteExportFormatLabel,
  renderRemotePdf,
  safeRemoteExportFilename,
  sanitizeRemoteQueries,
  sanitizeSearchFolder,
};
