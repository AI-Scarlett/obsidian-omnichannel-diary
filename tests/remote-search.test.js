"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { CaptureRouter, formatHelpText } = require("../src/core/router");
const { CHANNEL_IDS, DEFAULT_SETTINGS, migrateLegacySettings, normalizeSettings } = require("../src/core/settings");
const {
  REMOTE_EXPORT_FORMATS,
  REMOTE_EXPORT_SOURCE,
  RemoteSearchService,
  buildRemoteDocx,
  buildRemotePdfFromJpegs,
  composeRemoteMarkdown,
  markdownToRemotePlainText,
  parseRemoteCommand,
  parseRemoteIndexes,
  remoteExportFormat,
  stripRemoteCommandNoise,
} = require("../src/core/remote-search");

function makeVault(notes) {
  const files = new Map();
  for (const note of notes) {
    const name = note.path.split("/").pop();
    files.set(note.path, {
      path: note.path,
      name,
      basename: name.replace(/\.md$/, ""),
      extension: "md",
      stat: { mtime: note.mtime || 1000, size: Buffer.byteLength(note.content || "", "utf8") },
      content: note.content || "",
      cache: note.cache || null,
    });
  }
  return {
    _files: files,
    getMarkdownFiles: () => [...files.values()],
    cachedRead: async (file) => String((files.get(file.path) || {}).content || ""),
    getFileByPath: (path) => files.get(path) || null,
    getAbstractFileByPath: (path) => files.get(path) || null,
    add(note) {
      const name = note.path.split("/").pop();
      files.set(note.path, {
        path: note.path,
        name,
        basename: name.replace(/\.md$/, ""),
        extension: "md",
        stat: { mtime: note.mtime || Date.now(), size: Buffer.byteLength(note.content || "", "utf8") },
        content: note.content || "",
        cache: note.cache || null,
      });
    },
  };
}

function sampleNotes() {
  return [
    {
      path: "研究/人工智能.md",
      mtime: 2000,
      content: "---\ntitle: 人工智能\ndate: 2026-08-01\nsource: https://example.com/ai\n---\n\n秘密正文A：大模型评测笔记。\n",
      cache: { frontmatter: { title: "人工智能", date: "2026-08-01", source: "https://example.com/ai" } },
    },
    {
      path: "日记/杂记.md",
      mtime: 1500,
      content: "---\ntitle: 杂记\n---\n\n今天读到人工智能，但标题不是它。秘密正文B。\n",
      cache: { frontmatter: { title: "杂记" } },
    },
    {
      path: "研究/第二篇.md",
      mtime: 1800,
      content: "---\ntitle: 别的题目\naliases: [人工智能综述]\n---\n\n秘密正文C。\n",
      cache: { frontmatter: { title: "别的题目", aliases: ["人工智能综述"] } },
    },
  ];
}

function makeSettings(overrides = {}) {
  const settings = normalizeSettings({ schemaVersion: 1, ...overrides });
  if (overrides.remoteSearch) Object.assign(settings.remoteSearch, overrides.remoteSearch);
  return settings;
}

function makeService(opts = {}) {
  const vault = makeVault(opts.notes || sampleNotes());
  const settings = makeSettings(opts.settings);
  const service = new RemoteSearchService({
    getVault: () => vault,
    getMetadataCache: () => ({ getFileCache: (file) => (vault._files.get(file.path) || {}).cache || null }),
    getSettings: () => settings,
    persist: async () => { settings._persisted = true; },
  });
  return { vault, settings, service };
}

function unzipStore(buf) {
  const files = {};
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const sig = buf.readUInt32LE(offset);
    if (sig !== 0x04034b50) break;
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const size = buf.readUInt32LE(offset + 22);
    const name = buf.slice(offset + 30, offset + 30 + nameLen).toString("utf8");
    const start = offset + 30 + nameLen + extraLen;
    files[name] = buf.slice(start, start + size).toString("utf8");
    offset = start + size;
  }
  return files;
}

test("remote search defaults stay off and export format falls back to markdown", () => {
  assert.equal(DEFAULT_SETTINGS.remoteSearch.enabled, false);
  assert.equal(DEFAULT_SETTINGS.remoteSearch.exportFormat, "md");
  assert.equal(remoteExportFormat(DEFAULT_SETTINGS), "md");
  assert.equal(remoteExportFormat({ remoteSearch: { exportFormat: "xls" } }), "md");
  assert.equal(REMOTE_EXPORT_FORMATS.pdf.zh.includes("PDF"), true);
  const migrated = normalizeSettings(migrateLegacySettings({ settings: { diaryFolder: "旧日记" } }));
  assert.equal(migrated.remoteSearch.enabled, false);
  assert.deepEqual(migrated.runtime.remoteQueries, []);
});

test("command parsing requires a separator and ignores lookalike diary text", () => {
  assert.deepEqual(parseRemoteCommand("查 人工智能"), { type: "search", keyword: "人工智能", locale: "zh-CN" });
  assert.equal(parseRemoteCommand("查询：关键词").keyword, "关键词");
  assert.equal(parseRemoteCommand("查詢　手機卡").keyword, "手機卡");
  assert.equal(parseRemoteCommand("search keyword").keyword, "keyword");
  assert.equal(parseRemoteCommand("search keyword").locale, "en");
  assert.equal(parseRemoteCommand("find GEO").keyword, "GEO");
  assert.deepEqual(parseRemoteCommand("确认 1,3").indexes, [1, 3]);
  assert.deepEqual(parseRemoteCommand("confirm 1,3").indexes, [1, 3]);
  const exp = parseRemoteCommand("导出 Q0902-ABCD 1-2");
  assert.equal(exp.type, "export");
  assert.equal(exp.queryId, "Q0902-ABCD");
  assert.deepEqual(exp.indexes, [1, 2]);
  assert.equal(parseRemoteCommand("取消查询").type, "cancel");
  assert.equal(parseRemoteCommand("查询帮助").type, "help");
  assert.equal(parseRemoteCommand("search help").type, "help");
  assert.equal(parseRemoteCommand("查"), null);
  assert.equal(parseRemoteCommand("查手机卡"), null);
  assert.equal(parseRemoteCommand("查看一下明天的安排"), null);
  assert.equal(parseRemoteCommand("确认收到"), null);
  assert.deepEqual(parseRemoteIndexes("1，3"), [1, 3]);
});

test("Feishu mention prefixes and rich posts still parse as remote commands", () => {
  assert.equal(stripRemoteCommandNoise("@_user_1 查 手机卡"), "查 手机卡");
  assert.equal(parseRemoteCommand("@_user_1 查 手机卡").keyword, "手机卡");
  assert.equal(parseRemoteCommand("<at user_id=\"ou_1\">Bot</at> 确认 1").indexes[0], 1);
  assert.equal(parseRemoteCommand({"zh_cn":{"content":[[{"tag":"at","user_id":"ou_1"},{"tag":"text","text":" 查 人工智能"}]]}}).keyword, "人工智能");
});

test("disabled remote commands never capture or scan notes", async () => {
  let captures = 0;
  const replies = [];
  const router = new CaptureRouter({ capture: async () => { captures += 1; } }, () => ({}), { replyRetryDelays: [0] });
  await router.handle({ channel: "wechat", senderId: "u1", text: "查 人工智能", reply: async (text) => replies.push(text) });
  await router.handle({ channel: "feishu", senderId: "u1", text: "确认 1,3", reply: async (text) => replies.push(text) });
  assert.equal(captures, 0);
  assert.match(replies[0], /远程查询默认关闭/);
  assert.match(replies[0], /远程查询与导出/);
  assert.match(replies[1], /远程查询默认关闭/);
});

test("enabled search returns metadata only and isolates sessions by channel plus sender", async () => {
  const { vault, settings, service } = makeService({ settings: { remoteSearch: { enabled: true } } });
  const replies = [];
  const router = new CaptureRouter({ capture: async () => assert.fail("search must not capture") }, () => ({}), {
    replyRetryDelays: [0],
    getRemoteSearch: () => settings.remoteSearch,
    remoteSearch: service,
  });
  const first = await router.handle({ channel: "wechat", senderId: "alice", text: "查 人工智能", reply: async (text) => replies.push(text) });
  assert.equal(replies[0], "正在查询，请稍等！");
  assert.match(replies[1], /查询 Q\d{4}-[0-9A-F]{4}：找到 \d+ 条/);
  assert.match(replies[1], /人工智能/);
  assert.match(replies[1], /时间：/);
  assert.match(replies[1], /来源：/);
  assert.match(replies[1], /路径：研究\/人工智能.md/);
  assert.doesNotMatch(replies[1], /秘密正文A|秘密正文B|大模型评测/);
  assert.ok(replies[1].indexOf("研究/人工智能.md") < replies[1].indexOf("日记/杂记.md"));
  assert.match(replies[1], /格式由电脑端设置/);
  assert.match(replies[1], /Markdown \(.md\)/);
  assert.equal(first.session.candidates[0].path, "研究/人工智能.md");
  assert.equal(first.session.candidates.every((item) => item.content == null), true);

  await router.handle({ channel: "feishu", senderId: "alice", text: "查 人工智能", reply: async (text) => replies.push(text) });
  assert.equal(settings.runtime.remoteQueries.length, 2);
  assert.notEqual(settings.runtime.remoteQueries[0].id, settings.runtime.remoteQueries[1].id);
  assert.equal(settings.runtime.remoteQueries[0].ownerKey, "wechat:alice");
  assert.equal(settings.runtime.remoteQueries[1].ownerKey, "feishu:alice");
  assert.equal(vault.getMarkdownFiles().length, 3);
});

test("confirmation packs using the computer default format and sends the file through replyFile", async () => {
  const { settings, service } = makeService({ settings: { remoteSearch: { enabled: true, exportFormat: "md" } } });
  const replies = [];
  const sent = [];
  const router = new CaptureRouter({ capture: async () => assert.fail("export must not capture") }, () => ({}), {
    replyRetryDelays: [0],
    getRemoteSearch: () => settings.remoteSearch,
    remoteSearch: service,
  });
  await router.handle({ channel: "telegram", senderId: "bob", text: "查 人工智能", reply: async (text) => replies.push(text) });
  const exported = await router.handle({
    channel: "telegram",
    senderId: "bob",
    text: "确认 1,3",
    reply: async (text) => replies.push(text),
    replyFile: async (file) => { sent.push(file); },
  });
  assert.equal(replies.includes("正在打包并发送附件，请稍等！"), true);
  assert.equal(sent.length, 1);
  assert.equal(exported.command, "remote-export");
  assert.equal(exported.delivery.status, "sent");
  assert.equal(exported.file.format, "md");
  assert.match(exported.file.name, /\.md$/);
  assert.equal(Buffer.isBuffer(exported.file.buffer), true);
  const md = exported.file.buffer.toString("utf8");
  assert.match(md, /秘密正文A/);
  assert.match(md, /秘密正文B/);
  assert.doesNotMatch(md, /秘密正文C/);
  assert.match(md, /研究\/人工智能.md/);
  assert.match(replies.at(-1), /已按电脑端默认格式打包 2 条/);
  assert.match(replies.at(-1), /并已通过Telegram发送可打开的附件/);

  settings.remoteSearch.exportFormat = "txt";
  const txt = await router.handle({ channel: "telegram", senderId: "bob", text: "确认 1", reply: async (text) => replies.push(text) });
  assert.equal(txt.file.format, "txt");
  assert.match(txt.file.name, /\.txt$/);
  assert.match(txt.file.buffer.toString("utf8"), /秘密正文A/);
  assert.doesNotMatch(txt.file.buffer.toString("utf8"), /# Obsidian/);

  settings.remoteSearch.exportFormat = "docx";
  const docx = await router.handle({ channel: "telegram", senderId: "bob", text: "确认 1", reply: async (text) => replies.push(text) });
  assert.equal(docx.file.format, "docx");
  assert.equal(docx.file.buffer.slice(0, 2).toString(), "PK");
  const docxFiles = unzipStore(docx.file.buffer);
  assert.match(docxFiles["word/document.xml"], /秘密正文A/);
});

test("all nine channels share the same search commands", async () => {
  const { settings, service } = makeService({ settings: { remoteSearch: { enabled: true } } });
  const replies = [];
  const router = new CaptureRouter({ capture: async () => assert.fail("must not capture") }, () => ({}), {
    replyRetryDelays: [0],
    getRemoteSearch: () => settings.remoteSearch,
    remoteSearch: service,
  });
  for (const channel of CHANNEL_IDS) {
    const result = await router.handle({ channel, senderId: "same-user", text: "查 人工智能", reply: async (text) => replies.push(text) });
    assert.equal(result.command, "remote-search");
    assert.match(replies.at(-1), /路径：研究\/人工智能.md/);
  }
  assert.ok(settings.runtime.remoteQueries.length <= 5);
  assert.equal(new Set(settings.runtime.remoteQueries.map((item) => item.ownerKey)).size, settings.runtime.remoteQueries.length);
});

test("export uses the candidate map from search time and fails on stale files", async () => {
  const { vault, settings, service } = makeService({ settings: { remoteSearch: { enabled: true, exportFormat: "md" } } });
  const router = new CaptureRouter({ capture: async () => assert.fail("must not capture") }, () => ({}), {
    replyRetryDelays: [0],
    getRemoteSearch: () => settings.remoteSearch,
    remoteSearch: service,
  });
  await router.handle({ channel: "slack", senderId: "c1", text: "查 人工智能", reply: async () => {} });
  const firstPath = settings.runtime.remoteQueries[0].candidates[0].path;
  vault.add({
    path: "研究/置顶人工智能.md",
    mtime: 9000,
    content: "---\ntitle: 人工智能\n---\n\n新插入的更高分笔记，确认时不该顶替原第 1 条。\n",
    cache: { frontmatter: { title: "人工智能" } },
  });
  const mapped = await router.handle({ channel: "slack", senderId: "c1", text: "确认 1", reply: async () => {} });
  const packed = mapped.file.buffer.toString("utf8");
  assert.equal(firstPath, "研究/人工智能.md");
  assert.match(packed, /研究\/人工智能.md/);
  assert.match(packed, /秘密正文A/);
  assert.doesNotMatch(packed, /新插入的更高分/);

  const replies = [];
  await router.handle({ channel: "discord", senderId: "c2", text: "查 人工智能", reply: async () => {} });
  const overflow = await router.handle({ channel: "discord", senderId: "c2", text: "确认 99", reply: async (text) => replies.push(text) });
  assert.match(replies.join("\n"), /编号超出范围/);
  assert.equal(overflow.file, undefined);

  const discordSession = settings.runtime.remoteQueries.find((item) => item.ownerKey === "discord:c2");
  const queryId = discordSession.id;
  const firstCandidate = discordSession.candidates[0].path;
  vault._files.get(firstCandidate).stat.mtime = 99999;
  const changed = await router.handle({ channel: "discord", senderId: "c2", text: `确认 ${queryId} 1`, reply: async (text) => replies.push(text) });
  assert.match(replies.at(-1), /查询后发生了修改/);
  assert.equal(changed.file, undefined);

  settings.runtime.remoteQueries.find((item) => item.ownerKey === "discord:c2").expiresAt = Date.now() - 1;
  const expired = await router.handle({ channel: "discord", senderId: "c2", text: "确认 1", reply: async (text) => replies.push(text) });
  assert.match(replies.at(-1), /查询已过期/);
  assert.equal(expired.file, undefined);
  const cancel = await router.handle({ channel: "discord", senderId: "c2", text: "取消查询", reply: async (text) => replies.push(text) });
  assert.equal(cancel.command, "remote-cancel");
  assert.match(replies.at(-1), /已取消/);
});

test("folder scope excludes notes outside the configured directory", async () => {
  const { settings, service } = makeService({ settings: { remoteSearch: { enabled: true, folder: "研究" } } });
  const replies = [];
  const router = new CaptureRouter({ capture: async () => assert.fail("must not capture") }, () => ({}), {
    replyRetryDelays: [0],
    getRemoteSearch: () => settings.remoteSearch,
    remoteSearch: service,
  });
  await router.handle({ channel: "qq", senderId: "d1", text: "查 人工智能", reply: async (text) => replies.push(text) });
  assert.match(replies.join("\n"), /研究\/人工智能.md/);
  assert.doesNotMatch(replies.join("\n"), /日记\/杂记.md/);
});

test("missing replyFile leaves a packed-file receipt without capturing", async () => {
  const { settings, service } = makeService({ settings: { remoteSearch: { enabled: true, exportFormat: "md" } } });
  const replies = [];
  const router = new CaptureRouter({ capture: async () => assert.fail("must not capture") }, () => ({}), {
    replyRetryDelays: [0],
    getRemoteSearch: () => settings.remoteSearch,
    remoteSearch: service,
  });
  await router.handle({ channel: "telegram", senderId: "eve", text: "查 人工智能", reply: async () => {} });
  const result = await router.handle({ channel: "telegram", senderId: "eve", text: "确认 1", reply: async (text) => replies.push(text) });
  assert.equal(result.delivery.status, "unsupported");
  assert.match(replies.join("\n"), /发附件尚未接通/);
});

test("replyFile failure still reports the packed file and does not capture", async () => {
  const { settings, service } = makeService({ settings: { remoteSearch: { enabled: true, exportFormat: "md" } } });
  const replies = [];
  const router = new CaptureRouter({ capture: async () => assert.fail("must not capture") }, () => ({}), {
    replyRetryDelays: [0],
    getRemoteSearch: () => settings.remoteSearch,
    remoteSearch: service,
  });
  await router.handle({ channel: "wechat", senderId: "eve", text: "查 人工智能", reply: async () => {} });
  const result = await router.handle({
    channel: "wechat",
    senderId: "eve",
    text: "确认 1",
    reply: async (text) => replies.push(text),
    replyFile: async () => { throw new Error("CDN missing x-encrypted-param"); },
  });
  assert.equal(result.delivery.status, "failed");
  assert.match(replies.join("\n"), /未能发送可打开的附件/);
  assert.match(replies.join("\n"), /CDN missing x-encrypted-param/);
});

test("help stays capture-free and appends remote usage only when enabled", async () => {
  const disabled = formatHelpText("zh-CN");
  assert.match(disabled, /可用指令/);
  assert.doesNotMatch(disabled, /远程查询用法/);
  const enabled = formatHelpText("zh-CN", { remoteSearchEnabled: true, remoteExportFormat: "md" });
  assert.match(enabled, /远程查询用法/);
  assert.match(enabled, /聊天里不用再写格式/);
  assert.match(enabled, /尝试把可打开的附件发回当前渠道/);
  const replies = [];
  const router = new CaptureRouter({ capture: async () => assert.fail("help must not capture") }, () => ({ telegram: { state: "connected" } }), {
    replyRetryDelays: [0],
    getRemoteSearch: () => ({ enabled: true, exportFormat: "txt" }),
  });
  await router.handle({ text: "帮助", reply: async (text) => replies.push(text) });
  assert.match(replies[0], /远程查询用法/);
  assert.match(replies[0], /纯文本 \(.txt\)/);
});

test("pure export helpers keep markdown fidelity and PDF wrappers", () => {
  const notes = [{ title: "T", path: "a.md", time: "2026-09-02 10:00", source: "本地笔记", content: "这是 **粗体** 和 *斜体* 以及 `code`。" }];
  const mdOut = composeRemoteMarkdown(notes, { keyword: "T" });
  assert.match(mdOut, new RegExp(`source: ${REMOTE_EXPORT_SOURCE}`));
  assert.match(mdOut, /这是 \*\*粗体\*\*/);
  assert.equal(markdownToRemotePlainText(notes[0].content), "这是 粗体 和 斜体 以及 code。");
  const pdf = buildRemotePdfFromJpegs([{ width: 10, height: 10, jpeg: Buffer.from("jpeg") }]);
  assert.equal(pdf.slice(0, 8).toString("binary").startsWith("%PDF-1.4"), true);
  const docx = buildRemoteDocx("hello", "title");
  assert.equal(docx.slice(0, 2).toString(), "PK");
});

test("English search commands reply in English even when the app locale is Chinese", async () => {
  const { settings, service } = makeService({ settings: { remoteSearch: { enabled: true } } });
  const replies = [];
  const router = new CaptureRouter({ capture: async () => assert.fail("must not capture") }, () => ({}), {
    replyRetryDelays: [0],
    getLocale: () => "zh-CN",
    getRemoteSearch: () => settings.remoteSearch,
    remoteSearch: service,
  });
  await router.handle({ channel: "whatsapp", senderId: "en-user", text: "search 人工智能", reply: async (text) => replies.push(text) });
  assert.equal(replies[0], "Searching your notes. Please wait.");
  assert.match(replies[1], /Query Q\d{4}-[0-9A-F]{4}/);
  assert.match(replies[1], /To confirm, reply: confirm/);
});

test("Feishu and WhatsApp mentioned commands share the same search path", async () => {
  const { settings, service } = makeService({ settings: { remoteSearch: { enabled: true } } });
  const replies = [];
  const router = new CaptureRouter({ capture: async () => assert.fail("must not capture") }, () => ({}), {
    replyRetryDelays: [0],
    getRemoteSearch: () => settings.remoteSearch,
    remoteSearch: service,
  });
  const feishu = await router.handle({ channel: "feishu", senderId: "ou_1", text: "@_user_1 查 人工智能", reply: async (text) => replies.push(text) });
  const whatsapp = await router.handle({ channel: "whatsapp", senderId: "me", text: "查 人工智能", reply: async (text) => replies.push(text) });
  assert.equal(feishu.command, "remote-search");
  assert.equal(whatsapp.command, "remote-search");
  assert.equal(settings.runtime.remoteQueries.some((item) => item.ownerKey === "feishu:ou_1"), true);
  assert.equal(settings.runtime.remoteQueries.some((item) => item.ownerKey === "whatsapp:me"), true);
});

test("Slack and Discord mention prefixes still parse as remote commands", () => {
  assert.equal(parseRemoteCommand("<@U123> search notes").keyword, "notes");
  assert.equal(parseRemoteCommand("<@!987654321> 查 人工智能").keyword, "人工智能");
  assert.equal(parseRemoteCommand("<@U123|bot> confirm 1").indexes[0], 1);
});
