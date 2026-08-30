"use strict";

const { downloadRemoteFile, decodeDataUrl } = require("./network");
const { CodePlatformBookmarkStore, classifyCodePlatformUrl, normalizeCodePlatformMode } = require("./code-platforms");
const { WebClipper } = require("./webclip");
const { extractUrls, localDateParts, markdownEscape, safeFileName, shortHash } = require("./util");

class DiaryService {
  constructor(writer, getSettings, onSettingsChanged, options = {}) {
    this.writer = writer;
    this.getSettings = getSettings;
    this.onSettingsChanged = onSettingsChanged;
    this.sessionManager = options.sessionManager;
    this.webClipperFactory = options.webClipperFactory || ((writer, settings, clipperOptions) => new WebClipper(writer, settings, clipperOptions));
  }

  messageKey(envelope) {
    return `${envelope.channel}:${envelope.id || shortHash(`${envelope.timestamp}:${envelope.senderId}:${envelope.text}`)}`;
  }

  isDuplicate(envelope) {
    const settings = this.getSettings();
    return settings.runtime.recentMessageIds.includes(this.messageKey(envelope));
  }

  pendingReceipt(key) {
    return this.getSettings().runtime.pendingReceipts.find((item) => item.id === key)?.text || "";
  }

  async remember(key) {
    const settings = this.getSettings();
    if (!settings.runtime.recentMessageIds.includes(key)) settings.runtime.recentMessageIds.push(key);
    settings.runtime.recentMessageIds = settings.runtime.recentMessageIds.slice(-500);
    const retained = new Set(settings.runtime.recentMessageIds);
    settings.runtime.pendingReceipts = settings.runtime.pendingReceipts.filter((item) => retained.has(item.id));
    await this.onSettingsChanged();
  }

  async queueReceipt(key, text) {
    const settings = this.getSettings();
    settings.runtime.pendingReceipts = settings.runtime.pendingReceipts.filter((item) => item.id !== key);
    settings.runtime.pendingReceipts.push({ id: key, text: String(text), createdAt: new Date().toISOString() });
    settings.runtime.pendingReceipts = settings.runtime.pendingReceipts.slice(-100);
    await this.onSettingsChanged();
  }

  async completeReceipt(key) {
    const settings = this.getSettings();
    const next = settings.runtime.pendingReceipts.filter((item) => item.id !== key);
    if (next.length === settings.runtime.pendingReceipts.length) return;
    settings.runtime.pendingReceipts = next;
    await this.onSettingsChanged();
  }

  async materializeAttachment(attachment, folder, index) {
    const settings = this.getSettings();
    let payload;
    if (typeof attachment.load === "function") payload = await attachment.load();
    else if (attachment.buffer) payload = { ...attachment, buffer: Buffer.from(attachment.buffer) };
    else if (attachment.dataUrl) payload = decodeDataUrl(attachment.dataUrl, attachment.fileName);
    else if (attachment.url) {
      payload = await downloadRemoteFile(attachment.url, {
        headers: attachment.headers,
        referrer: attachment.referrer,
        mimeType: attachment.mimeType,
        fileName: attachment.fileName,
        maxBytes: settings.capture.maxFileMb * 1024 * 1024,
      });
    } else throw new Error("Attachment has no downloadable content");
    const maxBytes = settings.capture.maxFileMb * 1024 * 1024;
    if (!payload.buffer || payload.buffer.length > maxBytes) throw new Error(`Attachment exceeds ${settings.capture.maxFileMb} MB`);
    const name = safeFileName(payload.fileName || attachment.fileName, `attachment-${index + 1}`);
    const path = await this.writer.saveBinary(folder, name, payload.buffer, payload.mimeType || attachment.mimeType);
    return { path, mimeType: payload.mimeType || attachment.mimeType || "application/octet-stream" };
  }

  async capture(envelope) {
    const settings = this.getSettings();
    if (envelope.isGroup && !settings.capture.includeGroupMessages) return { ignored: "group-disabled" };
    if (envelope.isGroup && settings.capture.requireMentionInGroups && !envelope.mentioned) return { ignored: "mention-required" };
    const messageKey = this.messageKey(envelope);
    if (this.isDuplicate(envelope)) return { ignored: "duplicate", messageKey, pendingReceipt: this.pendingReceipt(messageKey) };

    const date = localDateParts(envelope.timestamp || new Date());
    const diaryPath = `${settings.storage.diaryFolder}/${date.day}.md`;
    const attachmentFolder = `${settings.storage.attachmentFolder}/Chat/${date.day}/${envelope.channel}`;
    const attachmentLines = [];
    const attachmentFailures = [];
    if (settings.capture.downloadChatAttachments) {
      for (const [index, attachment] of (envelope.attachments || []).entries()) {
        try {
          const saved = await this.materializeAttachment(attachment, attachmentFolder, index);
          attachmentLines.push(saved.mimeType.startsWith("image/") ? `![[${saved.path}]]` : `[[${saved.path}]]`);
        } catch (error) {
          const label = attachment.fileName || attachment.url || `附件 ${index + 1}`;
          attachmentFailures.push(`${label}: ${error?.message || error}`);
        }
      }
    }

    const clips = [];
    const clipFailures = [];
    const codeLinks = [];
    const codeLinkFailures = [];
    if (settings.capture.autoClipLinks) {
      const clipper = this.webClipperFactory(this.writer, settings, { sessionManager: this.sessionManager });
      const codeStore = new CodePlatformBookmarkStore(this.writer, settings);
      const codeMode = normalizeCodePlatformMode(settings.capture.codePlatformMode);
      for (const url of extractUrls(envelope.text).slice(0, 5)) {
        const codePlatform = classifyCodePlatformUrl(url, settings.capture.codePlatformAdditionalHosts);
        if (codePlatform && (codeMode === "bookmark" || codeMode === "both")) {
          try {
            codeLinks.push(await codeStore.save(url, { channel: envelope.channel, timestamp: envelope.timestamp }, codePlatform));
          } catch (error) {
            codeLinkFailures.push(`${url}: ${error?.message || error}`);
          }
        }
        if (!codePlatform || codeMode === "extract" || codeMode === "both") {
          try {
            clips.push(await clipper.save(url, { channel: envelope.channel, timestamp: envelope.timestamp }));
          } catch (error) {
            clipFailures.push(`${url}: ${error?.message || error}`);
          }
        }
      }
    }

    const title = `${date.time} · ${envelope.channelName || envelope.channel} · ${envelope.senderName || "未知发送者"}`;
    const lines = [`\n## ${title}\n`, String(envelope.text || "").trim() || "_无文字内容_", ""];
    if (attachmentLines.length) lines.push(...attachmentLines, "");
    for (const clip of clips) lines.push(`- 网页剪藏：[[${clip.notePath.replace(/\.md$/i, "")}]]（本地图片 ${clip.savedImages} 张）`);
    for (const link of codeLinks) lines.push(`- 代码平台收藏：[[${link.notePath.replace(/\.md$/i, "")}]]（${link.name} · ${link.repository}）`);
    if (attachmentFailures.length) lines.push(`> [!warning] ${attachmentFailures.length} 个聊天附件保存失败\n> ${attachmentFailures.join("\n> ")}`);
    if (clipFailures.length) lines.push(`> [!warning] ${clipFailures.length} 个链接提取失败，原始链接已保留\n> ${clipFailures.join("\n> ")}`);
    if (codeLinkFailures.length) lines.push(`> [!warning] ${codeLinkFailures.length} 个代码平台地址分类保存失败，原始链接已保留\n> ${codeLinkFailures.join("\n> ")}`);
    if (settings.storage.addSourceMetadata) {
      lines.push(`> [!info] 来源\n> 渠道：${envelope.channelName || envelope.channel} · 会话：${envelope.chatName || "私聊"} · 消息 ID：${envelope.id || "无"}`);
    }
    lines.push("");
    const initial = `---\ndate: ${date.day}\ntags:\n  - omnichannel-diary\n---\n\n# ${date.day}\n`;
    const file = await this.writer.append(diaryPath, `${lines.join("\n")}\n`, initial);
    await this.remember(messageKey);
    return {
      file,
      diaryPath,
      diaryFolder: settings.storage.diaryFolder,
      clippingFolder: settings.storage.clippingFolder,
      codePlatformFolder: settings.storage.codePlatformFolder,
      clips,
      codeLinks,
      savedAttachments: attachmentLines.length,
      attachmentFailures,
      clipFailures,
      codeLinkFailures,
      messageKey,
    };
  }
}

module.exports = { DiaryService };
