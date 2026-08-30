"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { WebClipper } = require("../src/core/webclip");
const { mimeExtension, safeFileName, shortHash } = require("../src/core/util");

function parseArguments(argv) {
  const vaultFlag = argv.indexOf("--vault");
  if (vaultFlag < 0 || !argv[vaultFlag + 1]) throw new Error("Usage: node scripts/repair-clips.js --vault <vault-path> <url...>");
  const vaultPath = path.resolve(argv[vaultFlag + 1]);
  const urls = argv.filter((value, index) => index !== vaultFlag && index !== vaultFlag + 1 && /^https?:\/\//i.test(value));
  if (!urls.length) throw new Error("At least one HTTP(S) URL is required");
  return { vaultPath, urls };
}

function vaultTarget(vaultPath, relativePath) {
  const target = path.resolve(vaultPath, String(relativePath).replace(/^[/\\]+/, ""));
  if (target !== vaultPath && !target.startsWith(`${vaultPath}${path.sep}`)) throw new Error("Refusing to write outside the Vault");
  return target;
}

function fileWriter(vaultPath) {
  return {
    async upsertText(relativePath, content) {
      const target = vaultTarget(vaultPath, relativePath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, "utf8");
      return relativePath;
    },
    async createText(relativePath, content) {
      return this.upsertText(relativePath, content);
    },
    async saveBinary(folderPath, requestedName, buffer, mimeType) {
      const folder = vaultTarget(vaultPath, folderPath);
      await fs.mkdir(folder, { recursive: true });
      const extension = mimeExtension(mimeType);
      let fileName = safeFileName(requestedName, `attachment.${extension}`);
      if (!/\.[a-z0-9]{1,8}$/i.test(fileName)) fileName = `${fileName}.${extension}`;
      let target = path.join(folder, fileName);
      try {
        const existing = await fs.readFile(target);
        if (existing.equals(buffer)) return path.relative(vaultPath, target).split(path.sep).join("/");
        const dot = fileName.lastIndexOf(".");
        const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
        const suffix = dot > 0 ? fileName.slice(dot) : "";
        target = path.join(folder, `${stem}-${shortHash(buffer)}${suffix}`);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await fs.writeFile(target, buffer);
      return path.relative(vaultPath, target).split(path.sep).join("/");
    },
  };
}

async function main() {
  const { vaultPath, urls } = parseArguments(process.argv.slice(2));
  const settingsPath = path.join(vaultPath, ".obsidian", "plugins", "omnichannel-diary", "data.json");
  const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  const clipper = new WebClipper(fileWriter(vaultPath), settings);
  for (const url of urls) {
    const result = await clipper.save(url, { channel: "wechat", timestamp: new Date() });
    process.stdout.write(`${JSON.stringify({ notePath: result.notePath, contentChars: result.article.contentChars, extractionStatus: result.article.extractionStatus, savedImages: result.savedImages, imageFailures: result.imageFailures.length })}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
