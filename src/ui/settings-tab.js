"use strict";

const QRCode = require("qrcode");
const { Modal, Notice, PluginSettingTab, Setting, setIcon } = require("obsidian");
const { CHANNEL_IDS, clearChannelCredentials, getChannelMeta } = require("../core/settings");
const { shortHash } = require("../core/util");

const SECTIONS = [
  { id: "overview", zh: "概览", en: "Overview", icon: "layout-dashboard" },
  { id: "channels", zh: "渠道", en: "Channels", icon: "messages-square" },
  { id: "capture", zh: "收集规则", en: "Capture rules", icon: "list-filter" },
  { id: "privacy", zh: "存储与隐私", en: "Storage & privacy", icon: "shield-check" },
];

const CHANNEL_FIELDS = {
  wechat: [],
  feishu: [
    { key: "domain", zh: "服务区域", en: "Service region", type: "select", options: { feishu: { zh: "飞书（中国）", en: "Feishu (China)" }, lark: { zh: "Lark（国际）", en: "Lark (International)" } } },
    { key: "appId", zh: "App ID", en: "App ID", placeholder: "cli_…" },
    { key: "appSecret", zh: "App Secret", en: "App Secret", secret: true },
  ],
  dingtalk: [{ key: "clientId", zh: "Client ID", en: "Client ID" }, { key: "clientSecret", zh: "Client Secret", en: "Client Secret", secret: true }],
  wecom: [{ key: "botId", zh: "机器人 ID", en: "Bot ID" }, { key: "secret", zh: "机器人 Secret", en: "Bot secret", secret: true }],
  qq: [{ key: "appId", zh: "App ID", en: "App ID" }, { key: "appSecret", zh: "App Secret", en: "App Secret", secret: true }],
  slack: [{ key: "appToken", zh: "App Token", en: "App token", placeholder: "xapp-…", secret: true }, { key: "botToken", zh: "Bot Token", en: "Bot token", placeholder: "xoxb-…", secret: true }],
  telegram: [{ key: "botToken", zh: "Bot Token", en: "Bot token", placeholder: "123456:…", secret: true }],
  discord: [{ key: "botToken", zh: "Bot Token", en: "Bot token", secret: true }],
  whatsapp: [],
};

const SETUP_LINKS = {
  dingtalk: "https://open-dev.dingtalk.com/",
  wecom: "https://work.weixin.qq.com/wework_admin/frame#apps",
  qq: "https://q.qq.com/",
  slack: "https://api.slack.com/apps",
  telegram: "https://t.me/BotFather",
  discord: "https://discord.com/developers/applications",
};

function iconButton(parent, label, icon, onClick, className = "") {
  const button = parent.createEl("button", { cls: `od-button ${className}`.trim() });
  const iconSpan = button.createSpan({ cls: "od-button-icon" });
  setIcon(iconSpan, icon);
  button.createSpan({ text: label });
  button.addEventListener("click", onClick);
  return button;
}

class PairingModal extends Modal {
  constructor(app, plugin, channelId) {
    super(app);
    this.plugin = plugin;
    this.channelId = channelId;
    this.closed = false;
  }

  onOpen() {
    const meta = getChannelMeta(this.channelId, this.plugin.locale());
    this.titleEl.setText(this.plugin.t("连接 {name}", "Connect {name}", { name: meta.name }));
    this.contentEl.addClass("od-pairing-modal");
    const brand = this.contentEl.createDiv({ cls: "od-pair-brand" });
    brand.createDiv({ cls: `od-channel-mark od-channel-${this.channelId}`, text: meta.mark });
    brand.createDiv({ cls: "od-pair-copy" }).createEl("p", { text: this.plugin.t(
      "授权只用于接收你发给机器人的内容；凭据保存在当前 Vault 的插件数据中。",
      "Authorization is used only to receive content you send to the bot. Credentials stay in this Vault's plugin data.",
    ) });
    this.qrBox = this.contentEl.createDiv({ cls: "od-qr-box od-qr-loading" });
    const spinner = this.qrBox.createDiv({ cls: "od-spinner" });
    spinner.setAttr("aria-label", this.plugin.t("正在生成二维码", "Generating QR code"));
    this.statusEl = this.contentEl.createEl("p", { cls: "od-pair-status", text: this.plugin.t("正在准备官方连接流程…", "Preparing the official connection flow…") });
    this.contentEl.createEl("p", { cls: "od-pair-footnote", text: this.plugin.t(
      "二维码由对应平台签发。若平台要求二次确认，请在手机端完成。",
      "The platform issues this QR code. Complete any additional confirmation on your phone.",
    ) });
    void this.startPairing();
  }

  async startPairing() {
    try {
      await this.plugin.channelManager.pair(this.channelId, {
        onQr: async (value) => {
          if (this.closed) return;
          const dataUrl = await QRCode.toDataURL(String(value), { width: 300, margin: 2, errorCorrectionLevel: "M" });
          this.qrBox.empty();
          this.qrBox.removeClass("od-qr-loading");
          const image = this.qrBox.createEl("img");
          image.setAttr("src", dataUrl);
          image.setAttr("alt", this.plugin.t("{name} 授权二维码", "{name} authorization QR code", { name: getChannelMeta(this.channelId, this.plugin.locale()).name }));
        },
        onStatus: (text) => {
          if (!this.closed) this.statusEl.setText(String(text));
        },
      });
      if (!this.closed) {
        this.statusEl.setText(this.plugin.t("{name} 已连接，可以关闭窗口。", "{name} is connected. You can close this window.", { name: getChannelMeta(this.channelId, this.plugin.locale()).name }));
        this.statusEl.addClass("is-success");
      }
    } catch (error) {
      if (!this.closed) {
        this.statusEl.setText(this.plugin.t("连接失败：{error}", "Connection failed: {error}", { error: error?.message || error }));
        this.statusEl.addClass("is-error");
      }
    }
  }

  onClose() {
    this.closed = true;
    this.contentEl.empty();
  }
}

class WhatsAppReconnectModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    this.titleEl.setText(this.plugin.t("重新关联 WhatsApp", "Relink WhatsApp"));
    this.contentEl.createEl("p", { text: this.plugin.t(
      "当前 Vault 已保存一组 WhatsApp 关联设备凭据。继续后，插件会先停止连接并把原凭据移动到可恢复的备份目录，再生成新的二维码。",
      "This Vault already has WhatsApp linked-device credentials. Continuing will stop the connection, move the old credentials to a recoverable backup, and generate a new QR code.",
    ) });
    this.contentEl.createEl("p", { cls: "od-pair-footnote", text: this.plugin.t(
      "此操作不会直接删除旧凭据；若新授权失败，可以从 .channel-data/whatsapp-auth-backups 恢复。",
      "The old credentials are not deleted. If relinking fails, restore them from .channel-data/whatsapp-auth-backups.",
    ) });
    const actions = this.contentEl.createDiv({ cls: "od-modal-actions" });
    iconButton(actions, this.plugin.t("取消", "Cancel"), "x", () => this.close(), "is-quiet");
    const proceed = iconButton(actions, this.plugin.t("备份并重新扫码", "Back up and rescan"), "scan-line", async () => {
      proceed.disabled = true;
      try {
        await this.plugin.channelManager.stop("whatsapp");
        this.plugin.backupWhatsAppAuth();
        this.plugin.settings.channels.whatsapp.enabled = false;
        await this.plugin.saveSettings();
        this.close();
        new PairingModal(this.app, this.plugin, "whatsapp").open();
      } catch (error) {
        new Notice(`WhatsApp：${error?.message || error}`, 8000);
        proceed.disabled = false;
      }
    }, "is-primary");
  }
}

class ManualCaptureModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    this.titleEl.setText(this.plugin.t("保存到 Omnichannel Diary", "Save to Omnichannel Diary"));
    this.contentEl.addClass("od-manual-modal");
    this.contentEl.createEl("p", { text: this.plugin.t(
      "粘贴文字或网页链接。链接会按当前收集规则提取正文与图片。",
      "Paste text or a web link. Links are processed using your current article and image capture rules.",
    ) });
    const textarea = this.contentEl.createEl("textarea", { cls: "od-manual-input" });
    textarea.setAttr("rows", "7");
    textarea.setAttr("placeholder", this.plugin.t("输入文字，或 https://example.com/article", "Enter text or https://example.com/article"));
    const actions = this.contentEl.createDiv({ cls: "od-modal-actions" });
    iconButton(actions, this.plugin.t("取消", "Cancel"), "x", () => this.close(), "is-quiet");
    const save = iconButton(actions, this.plugin.t("保存", "Save"), "save", async () => {
      const text = textarea.value.trim();
      if (!text) return;
      save.disabled = true;
      try {
        const result = await this.plugin.router.handle({
          channel: "manual", channelName: this.plugin.t("手动收集", "Manual capture"), id: `manual-${Date.now()}-${shortHash(text)}`,
          timestamp: new Date(), senderId: "local", senderName: this.plugin.t("本机", "This device"), chatName: "Obsidian", text, attachments: [],
        });
        new Notice(this.plugin.t("已保存到 {path}", "Saved to {path}", { path: result.diaryPath }));
        this.close();
      } catch (error) {
        new Notice(this.plugin.t("保存失败：{error}", "Save failed: {error}", { error: error?.message || error }), 7000);
        save.disabled = false;
      }
    }, "is-primary");
    setTimeout(() => textarea.focus(), 50);
  }
}

class DiarySettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.activeSection = "overview";
    this.unsubscribe = null;
    this.statusElements = new Map();
  }

  locale() {
    return this.plugin.locale();
  }

  tr(zh, en, values = {}) {
    return this.plugin.t(zh, en, values);
  }

  meta(id) {
    return getChannelMeta(id, this.locale());
  }

  display() {
    this.unsubscribe?.();
    this.unsubscribe = this.plugin.channelManager.subscribe((statuses) => this.refreshStatuses(statuses));
    this.render();
  }

  hide() {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  render() {
    const root = this.containerEl;
    root.empty();
    root.addClass("omnichannel-diary-settings");
    root.setAttr("lang", this.locale());
    this.statusElements.clear();
    this.renderHero(root);
    const shell = root.createDiv({ cls: "od-shell" });
    this.renderNav(shell.createDiv({ cls: "od-nav" }));
    const content = shell.createDiv({ cls: "od-content" });
    if (this.activeSection === "overview") this.renderOverview(content);
    if (this.activeSection === "channels") this.renderChannels(content);
    if (this.activeSection === "capture") this.renderCapture(content);
    if (this.activeSection === "privacy") this.renderPrivacy(content);
    this.refreshStatuses(this.plugin.channelManager.getStatuses());
  }

  renderHero(root) {
    const hero = root.createDiv({ cls: "od-hero" });
    const copy = hero.createDiv({ cls: "od-hero-copy" });
    copy.createDiv({ cls: "od-eyebrow", text: "LOCAL-FIRST CAPTURE" });
    copy.createEl("h1", { text: "Omnichannel Diary" });
    copy.createEl("p", { text: this.tr(
      "把聊天里的灵感、网页正文和附件，可靠地沉淀到当前 Obsidian Vault。没有 AI 路由，也不会把笔记上传到中间服务。",
      "Capture ideas, web articles, and attachments from chat into this Obsidian Vault. No AI routing and no intermediary note-upload service.",
    ) });
    const actions = hero.createDiv({ cls: "od-hero-actions" });
    iconButton(actions, this.tr("手动保存", "Manual capture"), "square-pen", () => new ManualCaptureModal(this.app, this.plugin).open(), "is-primary");
    iconButton(actions, this.tr("重连渠道", "Reconnect channels"), "refresh-cw", async () => {
      await this.plugin.channelManager.stopAll();
      await this.plugin.channelManager.startEnabled();
      new Notice(this.tr("已重新连接启用的渠道", "Enabled channels reconnected"));
    });
  }

  renderNav(nav) {
    for (const section of SECTIONS) {
      const button = nav.createEl("button", { cls: `od-nav-item ${this.activeSection === section.id ? "is-active" : ""}` });
      const icon = button.createSpan();
      setIcon(icon, section.icon);
      button.createSpan({ text: this.locale() === "en" ? section.en : section.zh });
      button.addEventListener("click", () => { this.activeSection = section.id; this.render(); });
    }
  }

  sectionHeader(parent, title, description) {
    const header = parent.createDiv({ cls: "od-section-header" });
    header.createEl("h2", { text: title });
    header.createEl("p", { text: description });
  }

  renderOverview(parent) {
    this.sectionHeader(parent, this.tr("一眼看清收集状态", "Capture status at a glance"), this.tr(
      "先连接一个渠道，再从对应聊天窗口发送文字、链接或附件。",
      "Connect a channel, then send text, links, or attachments from its chat window.",
    ));
    const metrics = parent.createDiv({ cls: "od-metrics" });
    const online = metrics.createDiv({ cls: "od-metric" });
    online.createSpan({ cls: "od-metric-label", text: this.tr("在线渠道", "Online channels") });
    this.overviewOnline = online.createEl("strong", { text: "0" });
    online.createSpan({ text: ` / ${CHANNEL_IDS.length}` });
    const enabled = metrics.createDiv({ cls: "od-metric" });
    enabled.createSpan({ cls: "od-metric-label", text: this.tr("已启用", "Enabled") });
    enabled.createEl("strong", { text: String(CHANNEL_IDS.filter((id) => this.plugin.settings.channels[id].enabled).length) });
    enabled.createSpan({ text: this.locale() === "en" ? "" : " 个" });
    const local = metrics.createDiv({ cls: "od-metric od-metric-wide" });
    local.createSpan({ cls: "od-metric-label", text: this.tr("日记目录", "Daily notes folder") });
    local.createEl("code", { text: this.plugin.settings.storage.diaryFolder });

    const language = parent.createDiv({ cls: "od-panel" });
    language.createEl("h3", { text: this.tr("语言", "Language") });
    new Setting(language)
      .setName(this.tr("界面与回复语言", "Interface and reply language"))
      .setDesc(this.tr("同时控制插件设置页面、弹窗和九个渠道的新回复。", "Controls the settings UI, dialogs, and new replies from all nine channels."))
      .addDropdown((dropdown) => dropdown
        .addOptions(this.locale() === "en" ? { auto: "Follow Obsidian", "zh-CN": "简体中文", en: "English" } : { auto: "跟随 Obsidian", "zh-CN": "简体中文", en: "English" })
        .setValue(this.plugin.settings.ui.language)
        .onChange(async (value) => {
          this.plugin.settings.ui.language = value;
          await this.plugin.saveSettings();
          this.render();
        }));

    const steps = parent.createDiv({ cls: "od-panel" });
    steps.createEl("h3", { text: this.tr("三步开始", "Get started in three steps") });
    const list = steps.createDiv({ cls: "od-step-list" });
    for (const [number, title, text] of (this.locale() === "en" ? [
      ["01", "Choose a channel", "Authorize with a QR code or enter the bot credentials issued by the platform."],
      ["02", "Send content", "Text goes to the daily note, links create article clippings, and attachments are stored locally."],
      ["03", "Return to Obsidian", "Each day has one note with clear sources, failures, and local attachments."],
    ] : [
      ["01", "选择渠道", "扫码授权，或填入平台签发的 Bot 凭据。"],
      ["02", "发送内容", "文字写入日记；链接额外生成正文剪藏；附件保存到本地目录。"],
      ["03", "回到 Obsidian", "每天一篇日记，来源、失败项和本地附件都有明确记录。"],
    ])) {
      const step = list.createDiv({ cls: "od-step" });
      step.createSpan({ cls: "od-step-number", text: number });
      const body = step.createDiv();
      body.createEl("strong", { text: title });
      body.createEl("p", { text });
    }

    const quick = parent.createDiv({ cls: "od-panel" });
    quick.createEl("h3", { text: this.tr("渠道速览", "Channel overview") });
    const grid = quick.createDiv({ cls: "od-mini-grid" });
    for (const id of CHANNEL_IDS) {
      const meta = this.meta(id);
      const item = grid.createDiv({ cls: "od-mini-channel" });
      item.createSpan({ cls: `od-mini-mark od-channel-${id}`, text: meta.mark });
      item.createSpan({ text: meta.name });
      const state = item.createSpan({ cls: "od-state-dot" });
      this.statusElements.set(id, { dot: state });
    }
  }

  renderChannels(parent) {
    this.sectionHeader(parent, this.tr("连接聊天渠道", "Connect chat channels"), this.tr(
      "微信、飞书/Lark 与 WhatsApp 支持扫码流程；其他平台的 Bot API 按官方规则使用应用凭据。",
      "WeChat, Feishu / Lark, and WhatsApp support QR flows. Other official bot APIs use app credentials issued by their platforms.",
    ));
    const grid = parent.createDiv({ cls: "od-channel-grid" });
    for (const id of CHANNEL_IDS) this.renderChannelCard(grid, id);
  }

  renderChannelCard(grid, id) {
    const meta = this.meta(id);
    const config = this.plugin.settings.channels[id];
    const card = grid.createEl("details", { cls: `od-channel-card od-channel-${id}` });
    const summary = card.createEl("summary");
    summary.createSpan({ cls: "od-channel-mark", text: meta.mark });
    const title = summary.createDiv({ cls: "od-channel-title" });
    title.createEl("strong", { text: meta.name });
    title.createSpan({ text: meta.setup });
    const badge = summary.createSpan({ cls: "od-status-badge", text: this.tr("未启用", "Disabled") });
    this.statusElements.set(id, { badge });
    const body = card.createDiv({ cls: "od-channel-body" });
    new Setting(body).setName(this.tr("启用此渠道", "Enable this channel")).setDesc(this.tr("Obsidian 打开时自动连接", "Connect automatically when Obsidian opens")).addToggle((toggle) => toggle.setValue(Boolean(config.enabled)).onChange(async (value) => {
      const previous = config.enabled;
      config.enabled = value;
      await this.plugin.saveSettings();
      try {
        if (value) await this.plugin.channelManager.start(id);
        else await this.plugin.channelManager.stop(id);
      } catch (error) {
        config.enabled = previous;
        await this.plugin.saveSettings();
        new Notice(`${meta.name}：${error?.message || error}`, 8000);
      }
      this.render();
    }));
    for (const field of CHANNEL_FIELDS[id]) this.renderChannelField(body, config, field);
    const actions = body.createDiv({ cls: "od-channel-actions" });
    if (["wechat", "feishu", "whatsapp"].includes(id)) {
      const hasWhatsAppAuth = id === "whatsapp" && this.plugin.hasWhatsAppAuth();
      const label = id === "feishu" ? this.tr("扫码创建应用", "Create app by QR") : hasWhatsAppAuth ? this.tr("重新扫码", "Scan again") : this.tr("扫码连接", "Connect by QR");
      iconButton(actions, label, "scan-line", () => {
        if (hasWhatsAppAuth) new WhatsAppReconnectModal(this.app, this.plugin).open();
        else new PairingModal(this.app, this.plugin, id).open();
      }, "is-primary");
    }
    if (SETUP_LINKS[id]) iconButton(actions, this.tr("打开官方设置", "Open official setup"), "external-link", () => window.open(SETUP_LINKS[id], "_blank", "noopener,noreferrer"), "is-quiet");
    iconButton(actions, this.tr("测试重连", "Test reconnection"), "plug-zap", async () => {
      try { await this.plugin.channelManager.restart(id); new Notice(this.tr("{name} 已发起重连", "Reconnection started for {name}", { name: meta.name })); }
      catch (error) { new Notice(`${meta.name}: ${error?.message || error}`, 8000); }
    });
    const runtime = body.createEl("p", { cls: "od-channel-runtime", text: this.tr("当前未启用", "Currently disabled") });
    this.statusElements.get(id).runtime = runtime;
    const note = body.createEl("p", { cls: "od-channel-note" });
    if (id === "wechat") note.setText(this.tr(
      "使用微信官方 iLink / ClawBot 授权，不是网页登录或设备模拟。功能是否可用取决于微信账号的开放范围。",
      "Uses official WeChat iLink / ClawBot authorization, not web-login or device emulation. Availability depends on your account's rollout access.",
    ));
    else if (id === "whatsapp") note.setText(this.tr(
      "通过 WhatsApp 官方“已关联设备”扫码。现有授权会直接重连；重新扫码前会先把旧凭据移入可恢复备份。",
      "Uses the official WhatsApp Linked Devices QR flow. Existing authorization reconnects directly; rescanning first moves old credentials to a recoverable backup.",
    ));
    else if (["telegram", "discord", "slack"].includes(id)) note.setText(this.tr(
      "该平台的官方 Bot 接口不提供个人账号扫码接入；请从官方开发者入口创建 Bot 并粘贴令牌。",
      "This platform's official bot API does not support personal-account QR login. Create a bot in the official developer portal and paste its token.",
    ));
    else note.setText(this.tr(
      "使用平台官方长连接 / Stream 接口，无需公网回调地址。",
      "Uses the platform's official persistent connection / Stream API and does not require a public callback URL.",
    ));
  }

  renderChannelField(parent, config, field) {
    const setting = new Setting(parent).setName(this.locale() === "en" ? field.en : field.zh);
    if (field.type === "select") {
      const options = Object.fromEntries(Object.entries(field.options).map(([value, labels]) => [value, this.locale() === "en" ? labels.en : labels.zh]));
      setting.addDropdown((dropdown) => dropdown.addOptions(options).setValue(config[field.key]).onChange(async (value) => {
        config[field.key] = value; await this.plugin.saveSettings();
      }));
      return;
    }
    setting.addText((input) => {
      input.setPlaceholder(field.placeholder || "").setValue(config[field.key] || "").onChange(async (value) => {
        config[field.key] = value.trim(); await this.plugin.saveSettings();
      });
      if (field.secret) input.inputEl.setAttr("type", "password");
    });
  }

  renderCapture(parent) {
    this.sectionHeader(parent, this.tr("决定内容怎样落盘", "Control how content is stored"), this.tr(
      "规则是确定性的；不调用模型，不对消息做语义判断。",
      "These rules are deterministic. No model is called and messages are not semantically classified.",
    ));
    const storage = parent.createDiv({ cls: "od-panel" });
    storage.createEl("h3", { text: this.tr("Vault 目录", "Vault folders") });
    for (const [key, name, desc] of (this.locale() === "en" ? [
      ["diaryFolder", "Daily notes", "Creates YYYY-MM-DD.md using the local date"],
      ["clippingFolder", "Web clippings", "Article text and source metadata"],
      ["attachmentFolder", "Local attachments", "Stores chat attachments and web images in separate subfolders"],
    ] : [
      ["diaryFolder", "每日笔记", "按本地日期生成 YYYY-MM-DD.md"],
      ["clippingFolder", "网页剪藏", "正文与来源元数据"],
      ["attachmentFolder", "本地附件", "聊天附件与网页图片分目录保存"],
    ])) {
      new Setting(storage).setName(name).setDesc(desc).addText((input) => input.setValue(this.plugin.settings.storage[key]).onChange(async (value) => {
        this.plugin.settings.storage[key] = value.trim(); await this.plugin.saveSettings();
      }));
    }
    const rules = parent.createDiv({ cls: "od-panel" });
    rules.createEl("h3", { text: this.tr("收集规则", "Capture rules") });
    this.addToggle(rules, this.tr("自动剪藏网页", "Automatically clip web pages"), this.tr("检测消息中的 HTTP(S) 链接并保存可读正文", "Detect HTTP(S) links in messages and save readable article text"), "autoClipLinks");
    this.addToggle(rules, this.tr("保存网页图片", "Save web images"), this.tr("把正文图片下载到 Vault；失败时保留远程地址并写明数量", "Download article images into the Vault; keep remote URLs and report failures"), "downloadWebImages");
    this.addToggle(rules, this.tr("保存聊天附件", "Save chat attachments"), this.tr("图片、文件、音频和视频按渠道保存", "Store images, files, audio, and video by channel"), "downloadChatAttachments");
    this.addToggle(rules, this.tr("收集群聊消息", "Capture group messages"), this.tr("关闭后只保存私聊", "When disabled, only direct messages are saved"), "includeGroupMessages");
    this.addToggle(rules, this.tr("群聊必须提及机器人", "Require a bot mention in groups"), this.tr("减少群聊噪声；需要平台提供 mention 信息", "Reduces group noise; requires mention metadata from the platform"), "requireMentionInGroups");
    new Setting(rules).setName(this.tr("单个附件上限", "Per-attachment limit")).setDesc("1–100 MB").addText((input) => {
      input.inputEl.setAttr("type", "number"); input.inputEl.setAttr("min", "1"); input.inputEl.setAttr("max", "100");
      input.setValue(String(this.plugin.settings.capture.maxFileMb)).onChange(async (value) => {
        this.plugin.settings.capture.maxFileMb = Math.min(100, Math.max(1, Number(value) || 20)); await this.plugin.saveSettings();
      });
    });
  }

  addToggle(parent, name, desc, key) {
    new Setting(parent).setName(name).setDesc(desc).addToggle((toggle) => toggle.setValue(Boolean(this.plugin.settings.capture[key])).onChange(async (value) => {
      this.plugin.settings.capture[key] = value; await this.plugin.saveSettings();
    }));
  }

  renderPrivacy(parent) {
    this.sectionHeader(parent, this.tr("数据边界清清楚楚", "Clear data boundaries"), this.tr(
      "插件没有遥测、账户系统、代理服务器或 AI 服务；但已启用渠道必须连接对应平台。",
      "The plugin has no telemetry, account system, proxy server, or AI service. Enabled channels still connect to their respective platforms.",
    ));
    const local = parent.createDiv({ cls: "od-panel od-privacy-panel" });
    local.createEl("h3", { text: this.tr("本地保存", "Local storage") });
    const points = local.createEl("ul");
    points.createEl("li", { text: this.tr("消息正文、网页正文和下载成功的附件写入当前 Vault。", "Message text, web articles, and successfully downloaded attachments are written to the current Vault.") });
    points.createEl("li", { text: this.tr("Bot Token、App Secret 和扫码会话凭据保存在插件 data.json 或 .channel-data 目录，未做额外加密。", "Bot tokens, app secrets, and QR session credentials are stored in the plugin's data.json or .channel-data directory without additional encryption.") });
    points.createEl("li", { text: this.tr("插件不会扫描与收集目录无关的笔记，也不会自动发布任何内容。", "The plugin does not scan notes outside its capture workflow and never publishes content automatically.") });
    const network = parent.createDiv({ cls: "od-panel od-privacy-panel" });
    network.createEl("h3", { text: this.tr("网络访问", "Network access") });
    network.createEl("p", { text: this.tr(
      "启用哪个渠道，就会连接该平台的官方 API/CDN；剪藏链接时会访问链接域名及正文图片域名。localhost、局域网和私有 IP 被阻止。",
      "Enabled channels connect to their official API/CDN. Clipping visits the link host and article-image hosts. localhost, local networks, and private IPs are blocked.",
    ) });
    const chips = network.createDiv({ cls: "od-domain-chips" });
    for (const domain of ["weixin.qq.com", "feishu.cn / larksuite.com", "dingtalk.com", "work.weixin.qq.com", "qq.com", "slack.com", "telegram.org", "discord.com", "whatsapp.net"]) {
      chips.createEl("code", { text: domain });
    }
    const credentials = parent.createDiv({ cls: "od-panel" });
    credentials.createEl("h3", { text: this.tr("清除渠道凭据", "Clear channel credentials") });
    credentials.createEl("p", { text: this.tr(
      "会停止渠道并从 data.json 删除该渠道的已保存字段。WhatsApp 的关联设备文件需要在插件目录 .channel-data 中手动删除，确保不会误删当前登录。",
      "This stops the channel and removes its saved fields from data.json. WhatsApp linked-device files must be removed manually from .channel-data to prevent accidental logout.",
    ) });
    const buttons = credentials.createDiv({ cls: "od-clear-grid" });
    for (const id of CHANNEL_IDS.filter((value) => value !== "whatsapp")) {
      const meta = this.meta(id);
      iconButton(buttons, meta.name, "key-round", async () => {
        await this.plugin.channelManager.stop(id);
        clearChannelCredentials(this.plugin.settings, id);
        await this.plugin.saveSettings();
        new Notice(this.tr("{name} 凭据已清除", "Credentials cleared for {name}", { name: meta.name }));
        this.render();
      }, "is-danger-quiet");
    }
  }

  refreshStatuses(statuses) {
    let online = 0;
    for (const [id, value] of Object.entries(statuses || {})) {
      if (value.state === "connected") online += 1;
      const elements = this.statusElements.get(id);
      if (!elements) continue;
      const state = value.state || "stopped";
      if (elements.dot) elements.dot.setAttr("data-state", state);
      if (elements.badge) {
        elements.badge.setAttr("data-state", state);
        elements.badge.setText(state === "connected" ? this.tr("已连接", "Connected")
          : state === "connecting" ? this.tr("连接中", "Connecting")
            : state === "pairing" ? this.tr("待扫码", "Scan required")
              : state === "error" ? this.tr("需处理", "Needs attention") : this.tr("未启用", "Disabled"));
        elements.badge.setAttr("title", value.detail || "");
      }
      if (elements.runtime) {
        elements.runtime.setAttr("data-state", state);
        const meta = this.meta(id);
        const identityDetail = ["whatsapp", "telegram", "discord"].includes(id)
          && value.detail
          && !/(在线|连接|online|connect)/i.test(value.detail) ? value.detail : "";
        if (state === "connected") elements.runtime.setText(identityDetail || this.tr("{name} 连接正常", "{name} connection healthy", { name: meta.name }));
        else if (state === "connecting") elements.runtime.setText(this.tr("正在连接 {name}", "Connecting to {name}", { name: meta.name }));
        else if (state === "pairing") elements.runtime.setText(this.tr("等待扫码连接 {name}", "Waiting for a QR scan for {name}", { name: meta.name }));
        else if (state === "error") elements.runtime.setText(value.detail || this.tr("连接异常", "Connection error"));
        else elements.runtime.setText(this.tr("当前未启用", "Currently disabled"));
      }
    }
    if (this.overviewOnline) this.overviewOnline.setText(String(online));
  }
}

module.exports = { DiarySettingTab, ManualCaptureModal, PairingModal };
