"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Plugin, Notice } = require("obsidian");
const { normalizeSettings } = require("./core/settings");
const { VaultWriter } = require("./core/vault");
const { DiaryService } = require("./core/diary");
const { CaptureRouter } = require("./core/router");
const { ChannelManager } = require("./channels");
const { DiarySettingTab, ManualCaptureModal } = require("./ui/settings-tab");

class OmnichannelDiaryPlugin extends Plugin {
  async onload() {
    const saved = await this.loadData();
    this.settings = normalizeSettings(saved);
    this.migrateLegacyRuntimeData();
    if (saved?.schemaVersion !== 1) await this.saveSettings();
    this.writer = new VaultWriter(this.app.vault);
    this.diary = new DiaryService(this.writer, () => this.settings, () => void this.saveSettings());
    this.channelManager = new ChannelManager(this, async (envelope) => this.router.handle(envelope));
    this.router = new CaptureRouter(this.diary, () => this.channelManager.getStatuses());
    this.settingTab = new DiarySettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    this.addRibbonIcon("inbox", "Omnichannel Diary", () => {
      this.app.setting.open();
      this.app.setting.openTabById(this.manifest.id);
    });
    this.addCommand({
      id: "capture-text-or-link",
      name: "保存文字或网页链接",
      callback: () => new ManualCaptureModal(this.app, this).open(),
    });
    this.addCommand({
      id: "restart-enabled-channels",
      name: "重新连接已启用渠道",
      callback: async () => {
        await this.channelManager.stopAll();
        await this.channelManager.startEnabled();
        new Notice("Omnichannel Diary 已重新连接渠道");
      },
    });
    this.app.workspace.onLayoutReady(() => void this.channelManager.startEnabled());
  }

  async onunload() {
    await this.channelManager?.stopAll();
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  dataPath(name) {
    const adapter = this.app.vault.adapter;
    const basePath = typeof adapter.getBasePath === "function" ? adapter.getBasePath() : adapter.basePath;
    if (!basePath) throw new Error("当前 Vault 适配器不支持本地数据目录");
    const directory = path.join(basePath, this.app.vault.configDir, "plugins", this.manifest.id, ".channel-data", name);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    return directory;
  }

  runtimePath() {
    const adapter = this.app.vault.adapter;
    const basePath = typeof adapter.getBasePath === "function" ? adapter.getBasePath() : adapter.basePath;
    if (!basePath) throw new Error("当前 Vault 适配器不支持本地插件入口");
    return path.join(basePath, this.app.vault.configDir, "plugins", this.manifest.id, "main.js");
  }

  migrateLegacyRuntimeData() {
    const adapter = this.app.vault.adapter;
    const basePath = typeof adapter.getBasePath === "function" ? adapter.getBasePath() : adapter.basePath;
    if (!basePath) return;
    const pluginDirectory = path.join(basePath, this.app.vault.configDir, "plugins", this.manifest.id);
    const legacyWhatsApp = path.join(pluginDirectory, "whatsapp-auth");
    const targetParent = path.join(pluginDirectory, ".channel-data");
    const targetWhatsApp = path.join(targetParent, "whatsapp-auth");
    if (fs.existsSync(legacyWhatsApp) && !fs.existsSync(targetWhatsApp)) {
      fs.mkdirSync(targetParent, { recursive: true, mode: 0o700 });
      fs.renameSync(legacyWhatsApp, targetWhatsApp);
    }
  }
}

module.exports = OmnichannelDiaryPlugin;
