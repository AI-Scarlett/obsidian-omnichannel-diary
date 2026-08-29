"use strict";

const { normalizePath } = require("obsidian");
const { mimeExtension, safeFileName, shortHash } = require("./util");

class VaultWriter {
  constructor(vault) {
    this.vault = vault;
    this.pending = new Map();
  }

  async ensureFolder(folderPath) {
    const normalized = normalizePath(folderPath || "");
    if (!normalized) return;
    let current = "";
    for (const segment of normalized.split("/")) {
      current = current ? `${current}/${segment}` : segment;
      if (!this.vault.getAbstractFileByPath(current)) {
        try {
          await this.vault.createFolder(current);
        } catch (error) {
          if (!this.vault.getAbstractFileByPath(current)) throw error;
        }
      }
    }
  }

  async createText(filePath, content) {
    const normalized = normalizePath(filePath);
    await this.ensureFolder(normalized.split("/").slice(0, -1).join("/"));
    const existing = this.vault.getAbstractFileByPath(normalized);
    if (existing) return existing;
    return this.vault.create(normalized, content);
  }

  async append(filePath, content, initial = "") {
    const normalized = normalizePath(filePath);
    const previous = this.pending.get(normalized) || Promise.resolve();
    const next = previous.then(async () => {
      let file = this.vault.getAbstractFileByPath(normalized);
      if (!file) file = await this.createText(normalized, initial);
      const current = await this.vault.read(file);
      await this.vault.modify(file, `${current}${content}`);
      return file;
    });
    this.pending.set(normalized, next.catch(() => undefined));
    return next;
  }

  async saveBinary(folderPath, requestedName, buffer, mimeType = "application/octet-stream") {
    const folder = normalizePath(folderPath);
    await this.ensureFolder(folder);
    const guessedExtension = mimeExtension(mimeType);
    let fileName = safeFileName(requestedName, `attachment.${guessedExtension}`);
    if (!/\.[a-z0-9]{1,8}$/i.test(fileName)) fileName = `${fileName}.${guessedExtension}`;
    let path = normalizePath(`${folder}/${fileName}`);
    const existing = this.vault.getAbstractFileByPath(path);
    if (existing) {
      const dot = fileName.lastIndexOf(".");
      const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
      const extension = dot > 0 ? fileName.slice(dot) : "";
      path = normalizePath(`${folder}/${stem}-${shortHash(buffer)}${extension}`);
      const duplicate = this.vault.getAbstractFileByPath(path);
      if (duplicate) return path;
    }
    await this.vault.createBinary(path, buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
    return path;
  }
}

module.exports = { VaultWriter };
