"use strict";

const { downloadRemoteFile, decodeDataUrl } = require("./network");
const { CodePlatformBookmarkStore, classifyCodePlatformUrl, normalizeCodePlatformMode } = require("./code-platforms");
const { extractPdf } = require("./pdfclip");
const { WebClipper } = require("./webclip");
const { extractUrls, localDateParts, markdownEscape, safeFileName, shortHash } = require("./util");
const { classifyClipFamily, isClipFamilyEnabled } = require("./clip-rules");

function isPdfAttachment(saved) {
  return String(saved.mimeType || "").toLowerCase().includes("application/pdf") || /\.pdf$/i.test(saved.fileName || "");
}

function attachmentSourceUrl(envelope, fileName) {
  return `attachment://${encodeURIComponent(envelope.channel || "chat")}/${encodeURIComponent(envelope.id || "message")}/${encodeURIComponent(fileName || "document.pdf")}`;
}

function normalizeDiaryMessage(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n[\t ]*\n+/g, "\n")
    .split("\n")
    .map((line) => /^(?:#{1,6}\s|---\s*$|_\()/.test(line) ? `\\${line}` : line)
    .join("\n")
    .trim();
}

function safeDiaryLabel(value, fallback) {
  const compact = String(value || fallback || "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return markdownEscape(compact || fallback || "");
}

async function mapCaptureTargets(targets, concurrency, worker) {
  const results = new Array(targets.length);
  let cursor = 0;
  const run = async () => {
    while (cursor < targets.length) {
      const index = cursor;
      cursor += 1;
      try { results[index] = { value: await worker(targets[index], index) }; }
      catch (error) { results[index] = { error }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, run));
  return results;
}

class DiaryService {
  constructor(writer, getSettings, onSettingsChanged, options = {}) {
    this.writer = writer;
    this.getSettings = getSettings;
    this.onSettingsChanged = onSettingsChanged;
    this.sessionManager = options.sessionManager;
    this.pdfExtractor = options.pdfExtractor || extractPdf;
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
    return {
      path,
      fileName: name,
      mimeType: payload.mimeType || attachment.mimeType || "application/octet-stream",
      buffer: Buffer.from(payload.buffer),
    };
  }

  async capture(envelope) {
    const settings = this.getSettings();
    const messageKey = this.messageKey(envelope);
    if (this.isDuplicate(envelope)) return { ignored: "duplicate", messageKey, pendingReceipt: this.pendingReceipt(messageKey) };

    const date = localDateParts(envelope.timestamp || new Date());
    const diaryPath = `${settings.storage.diaryFolder}/${date.day}.md`;
    const attachmentFolder = `${settings.storage.attachmentFolder}/Chat/${date.day}/${envelope.channel}`;
    const attachmentLines = [];
    const attachmentFailures = [];
    const attachmentExtractionFailures = [];
    const clips = [];
    const clipFailures = [];
    const codeLinks = [];
    const codeLinkFailures = [];
    let clipper;
    const getClipper = () => {
      if (!clipper) clipper = this.webClipperFactory(this.writer, settings, { sessionManager: this.sessionManager });
      return clipper;
    };
    if (settings.capture.downloadChatAttachments) {
      for (const [index, attachment] of (envelope.attachments || []).entries()) {
        try {
          const saved = await this.materializeAttachment(attachment, attachmentFolder, index);
          attachmentLines.push(saved.mimeType.startsWith("image/") ? `![[${saved.path}]]` : `[[${saved.path}]]`);
          if (isPdfAttachment(saved) && isClipFamilyEnabled(settings, "pdfs")) {
            try {
              const sourceUrl = attachmentSourceUrl(envelope, saved.fileName);
              const article = await this.pdfExtractor(
                saved.buffer,
                sourceUrl,
                `attachment; filename*=UTF-8''${encodeURIComponent(saved.fileName)}`,
              );
              const originalLink = `[Original PDF](${encodeURI(saved.path)})`;
              clips.push(await getClipper().saveArticle({
                ...article,
                binaryFiles: [],
                markdown: `${originalLink}\n\n${article.markdown || article.excerpt || ""}`,
              }, { channel: envelope.channel, timestamp: envelope.timestamp }));
            } catch (error) {
              attachmentExtractionFailures.push(`${saved.fileName}: ${error?.message || error}`);
            }
          }
        } catch (error) {
          const label = attachment.fileName || attachment.url || `附件 ${index + 1}`;
          attachmentFailures.push(`${label}: ${error?.message || error}`);
        }
      }
    }

    if (settings.capture.autoClipLinks) {
      const codeStore = new CodePlatformBookmarkStore(this.writer, settings);
      const codeMode = normalizeCodePlatformMode(settings.capture.codePlatformMode);
      const clipTargets = [];
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
          if (isClipFamilyEnabled(settings, classifyClipFamily(url))) clipTargets.push(url);
          else clipFailures.push(`${url}: 该剪藏类型已关闭`);
        }
      }
      const messageBudgetMs = Math.max(15, Number(settings.capture.webClipBudgetSeconds) || 75) * 1000;
      const deadline = Date.now() + messageBudgetMs;
      const results = await mapCaptureTargets(clipTargets, 2, (url) => getClipper().save(url, {
        channel: envelope.channel,
        timestamp: envelope.timestamp,
        deadline,
      }));
      results.forEach((result, index) => {
        if (result?.value) clips.push(result.value);
        else if (result?.error) clipFailures.push(`${clipTargets[index]}: ${result.error?.message || result.error}`);
      });
    }

    const title = `${date.time} · ${safeDiaryLabel(envelope.channelName || envelope.channel, "channel")} · ${safeDiaryLabel(envelope.senderName, "未知发送者")}`;
    const lines = [`\n## ${title}\n`, normalizeDiaryMessage(envelope.text) || "_无文字内容_", ""];
    if (attachmentLines.length) lines.push(...attachmentLines, "");
    for (const clip of clips) {
      const pdfAttachment = String(clip.article?.url || "").startsWith("attachment:");
      const detail = pdfAttachment ? `正文 ${Number(clip.article?.pageCount) || 0} 页` : `本地图片 ${clip.savedImages} 张`;
      lines.push(`- ${pdfAttachment ? "PDF 剪藏" : "网页剪藏"}：[[${clip.notePath.replace(/\.md$/i, "")}]]（${detail}）`);
    }
    for (const link of codeLinks) lines.push(`- 代码平台收藏：[[${link.notePath.replace(/\.md$/i, "")}]]（${link.name} · ${link.repository}）`);
    if (attachmentFailures.length) lines.push(`> [!warning] ${attachmentFailures.length} 个聊天附件保存失败\n> ${attachmentFailures.join("\n> ")}`);
    if (attachmentExtractionFailures.length) lines.push(`> [!warning] ${attachmentExtractionFailures.length} 个 PDF 附件正文提取失败，原文件已保存\n> ${attachmentExtractionFailures.join("\n> ")}`);
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
      attachmentExtractionFailures,
      clipFailures,
      codeLinkFailures,
      messageKey,
    };
  }
}

module.exports = { DiaryService, attachmentSourceUrl, isPdfAttachment, mapCaptureTargets, normalizeDiaryMessage, safeDiaryLabel };
