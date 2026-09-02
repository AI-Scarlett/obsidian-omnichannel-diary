"use strict";

const QRCode = require("qrcode");
const { Modal, Notice, PluginSettingTab, Setting, setIcon } = require("obsidian");
const { CHANNEL_IDS, clearChannelCredentials, getChannelMeta } = require("../core/settings");
const { CLIP_FAMILIES, CLIP_FAMILY_IDS } = require("../core/clip-rules");
const { REMOTE_EXPORT_FORMATS, remoteExportFormat } = require("../core/remote-search");
const { codePlatformCoverage } = require("../core/code-platforms");
const { COMMUNITY_SERVICES, DOCUMENT_SERVICES, communityCoverage } = require("../core/web-platforms");
const { shortHash } = require("../core/util");

const PROJECT_URL = "https://github.com/AI-Scarlett/obsidian-omnichannel-diary";

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
  whatsapp: [{
    key: "nodePath",
    zh: "Node.js 路径（可选）",
    en: "Node.js path (optional)",
    placeholder: process.platform === "win32" ? "C:\\Program Files\\nodejs\\node.exe" : "/opt/homebrew/bin/node",
  }],
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
      "粘贴文字或网页链接。普通链接会提取文章、云文档、PDF 和技术社区内容；代码平台地址按设置提取、分类收藏，或两者都做。",
      "Paste text or a web link. Regular links extract articles, cloud documents, PDFs, and technical-community content. Code-platform links are extracted, filed as categorized bookmarks, or both according to your settings.",
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
      "把聊天里的灵感、网页、代码平台地址、云文档、PDF、技术社区讨论和附件，可靠地沉淀到当前 Obsidian Vault。没有 AI 路由，也不会把笔记上传到中间服务。",
      "Capture ideas, web pages, code-platform links, cloud documents, PDFs, technical-community discussions, and attachments into this Obsidian Vault. No AI routing and no intermediary note-upload service.",
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

    const star = parent.createDiv({ cls: "od-star-card" });
    const starIcon = star.createSpan({ cls: "od-star-icon" });
    setIcon(starIcon, "star");
    const starCopy = star.createDiv({ cls: "od-star-copy" });
    starCopy.createEl("strong", { text: this.tr("喜欢这个插件？", "Enjoying this plugin?") });
    starCopy.createEl("p", { text: this.tr(
      "在 GitHub 上点个 Star，可以帮助更多 Obsidian 创作者发现它。",
      "Star it on GitHub to help more Obsidian creators discover it.",
    ) });
    iconButton(star, this.tr("在 GitHub 上点 Star", "Star on GitHub"), "github", () => {
      window.open(PROJECT_URL, "_blank", "noopener,noreferrer");
    }, "od-star-button");

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
      ["02", "Send content", "Text goes to the daily note; pages become clippings; code-platform links follow their dedicated filing rule; attachments stay local."],
      ["03", "Return to Obsidian", "Each day has one note with clear sources, failures, and local attachments."],
    ] : [
      ["01", "选择渠道", "扫码授权，或填入平台签发的 Bot 凭据。"],
      ["02", "发送内容", "文字写入日记；网页生成剪藏；代码平台地址按专用规则分类；附件保存在本地。"],
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
      "通过 WhatsApp 官方“已关联设备”扫码。连接在独立 Node.js 20.18+ 进程中运行，避免 WhatsApp 故障导致 Obsidian 白屏；通常会自动查找 Node.js。",
      "Uses the official WhatsApp Linked Devices QR flow in an isolated Node.js 20.18+ process so a WhatsApp failure cannot blank Obsidian. Node.js is normally detected automatically.",
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
      ["clippingFolder", "Web clippings root", "Root folder; each clipping type below can use its own subfolder"],
      ["codePlatformFolder", "Code-platform links", "Categorized bookmark notes grouped by platform"],
      ["attachmentFolder", "Local attachments", "Stores chat attachments and web images in separate subfolders"],
    ] : [
      ["diaryFolder", "每日笔记", "按本地日期生成 YYYY-MM-DD.md"],
      ["clippingFolder", "网页剪藏根目录", "总目录；下面每种剪藏类型可再设子目录"],
      ["codePlatformFolder", "代码平台收藏", "按平台分组保存代码仓库与资源地址"],
      ["attachmentFolder", "本地附件", "聊天附件与网页图片分目录保存"],
    ])) {
      new Setting(storage).setName(name).setDesc(desc).addText((input) => input.setValue(this.plugin.settings.storage[key]).onChange(async (value) => {
        this.plugin.settings.storage[key] = value.trim(); await this.plugin.saveSettings();
      }));
    }
    const rules = parent.createDiv({ cls: "od-panel" });
    rules.createEl("h3", { text: this.tr("收集规则", "Capture rules") });
    this.addToggle(rules, this.tr("自动剪藏网页", "Automatically clip web pages"), this.tr("检测消息中的 HTTP(S) 链接并按下面的类型规则保存", "Detect HTTP(S) links in messages and save them using the type rules below"), "autoClipLinks");
    this.addToggle(rules, this.tr("保存网页图片", "Save web images"), this.tr("把正文图片下载到 Vault；失败时保留远程地址并写明数量", "Download article images into the Vault; keep remote URLs and report failures"), "downloadWebImages");
    this.addToggle(rules, this.tr("渲染动态网页与云文档", "Render dynamic pages and cloud documents"), this.tr(
      "用独立本地浏览器提取云文档及国内外技术社区的正文、问答和评论",
      "Use an isolated local browser for cloud documents and posts, answers, and comments from technical communities worldwide",
    ), "renderDynamicPages");
    this.addToggle(rules, this.tr("保存聊天附件", "Save chat attachments"), this.tr("图片、文件、音频和视频按渠道保存", "Store images, files, audio, and video by channel"), "downloadChatAttachments");
    const clipRules = parent.createDiv({ cls: "od-panel" });
    clipRules.createEl("h3", { text: this.tr("剪藏类型", "Clipping types") });
    clipRules.createEl("p", { text: this.tr(
      "手机发来的链接按类型分流，不再全部堆进同一个剪藏目录。关闭某类型后，该类型链接只留在当天日记里，不生成剪藏。子目录相对上面的剪藏根目录；留空则直接写到根目录。",
      "Links from chat are filed by type instead of one mixed clipping folder. If a type is off, that link stays in today's note and is not clipped. Subfolders are relative to the clipping root above; leave empty to write into the root.",
    ) });
    for (const id of CLIP_FAMILY_IDS) {
      const family = CLIP_FAMILIES[id];
      const rule = this.plugin.settings.capture.clipRules[id] || { enabled: true, folder: family.defaultFolder };
      const row = clipRules.createDiv({ cls: "od-clip-rule" });
      new Setting(row)
        .setName(this.tr(family.zh, family.en))
        .setDesc(this.tr(family.zhDesc, family.enDesc))
        .addToggle((toggle) => toggle.setValue(rule.enabled !== false).onChange(async (value) => {
          this.plugin.settings.capture.clipRules[id].enabled = value;
          await this.plugin.saveSettings();
        }));
      new Setting(row)
        .setName(this.tr("保存到子目录", "Save to subfolder"))
        .setDesc(this.tr("相对网页剪藏根目录", "Relative to the web-clippings root"))
        .addText((input) => input.setPlaceholder(family.defaultFolder).setValue(rule.folder || "").onChange(async (value) => {
          this.plugin.settings.capture.clipRules[id].folder = value.trim();
          await this.plugin.saveSettings();
        }));
    }
    const remote = parent.createDiv({ cls: "od-panel" });
    remote.createEl("h3", { text: this.tr("远程查询与导出", "Remote search and export") });
    remote.createEl("p", { text: this.tr(
      "查询和打包是插件内置能力，九个渠道共用。渠道 SDK 已经打进本插件，只要在「渠道」页启用并授权即可，不必另装依赖或插件。确认后会按该渠道官方接口尝试发回文件；失败时仍会留下文字回执。WhatsApp 仍可能需要本机 Node.js 20.18+，那是隔离进程，与导出无关。",
      "Search and packing are built into this plugin and shared by all nine channels. Channel SDKs are already bundled, so enable and authorize a channel on the Channels page—do not install extra packages. After confirmation the plugin tries to send the packed file through that channel's official API; a text receipt remains if sending fails. WhatsApp may still need local Node.js 20.18+, which is an isolated process and unrelated to export.",
    ) });
    new Setting(remote)
      .setName(this.tr("允许 Bot 查询笔记", "Allow the bot to search notes"))
      .setDesc(this.tr(
        "默认关闭。开启后，已连接渠道可发送“查 关键词”（查 和关键词之间必须有空格；查手机卡会记进日记）。插件只返回标题、时间、来源和路径；你回复“确认 1,3”或 “confirm 1,3” 后才读取全文、按电脑端默认格式打包，并尝试把可打开的附件发回当前渠道。电脑需开着 Obsidian。",
        "Off by default. When enabled, a connected channel can send “search keyword” or “查 关键词”. A space after the command is required; “查手机卡” is saved as diary text. The plugin returns only title, time, source, and path. After you reply “confirm 1,3” or “确认 1,3”, it packs the notes on this computer and tries to send an openable file on the current channel. Obsidian must stay open on this computer.",
      ))
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.remoteSearch.enabled === true).onChange(async (value) => {
        this.plugin.settings.remoteSearch.enabled = value;
        if (!value) this.plugin.remoteSearch?.clearAll();
        await this.plugin.saveSettings();
        this.render();
      }));
    new Setting(remote)
      .setName(this.tr("查询范围", "Search folder"))
      .setDesc(this.tr(
        "只搜索这个文件夹下的 Markdown 笔记。留空表示整个库。",
        "Search Markdown notes only in this folder. Leave empty for the whole vault.",
      ))
      .addText((input) => input.setPlaceholder("/").setValue(this.plugin.settings.remoteSearch.folder || "").onChange(async (value) => {
        this.plugin.settings.remoteSearch.folder = value.trim();
        this.plugin.remoteSearch?.clearAll();
        await this.plugin.saveSettings();
      }));
    const currentExportFormat = remoteExportFormat(this.plugin.settings);
    const formatOptions = {};
    for (const [id, labels] of Object.entries(REMOTE_EXPORT_FORMATS)) formatOptions[id] = this.locale() === "en" ? labels.en : labels.zh;
    new Setting(remote)
      .setName(this.tr("默认导出格式", "Default export format"))
      .setDesc(this.tr(
        "Bot 端只回复要导出的编号，不再选择格式。MD 最快且完整保留原文；PDF 使用系统中文字体生成图像型页面，显示稳定但正文不可选中复制。",
        "The bot only replies with item numbers and never chooses a format. Markdown is fastest and keeps the original text. PDF uses system CJK fonts as image pages, so display is stable but text is not selectable.",
      ))
      .addDropdown((dropdown) => dropdown.addOptions(formatOptions).setValue(currentExportFormat).onChange(async (value) => {
        this.plugin.settings.remoteSearch.exportFormat = Object.prototype.hasOwnProperty.call(REMOTE_EXPORT_FORMATS, value) ? value : "md";
        await this.plugin.saveSettings();
      }));
    if (this.plugin.settings.remoteSearch.enabled === true) {
      remote.createEl("p", { cls: "setting-item-description", text: this.tr(
        "命令必须带空格：查 关键词 → 确认 1,3；英文 search keyword → confirm 1,3。查询结果 2 小时过期；一次最多显示 10 条、导出 20 条，导出文件上限 20MB。",
        "A space is required: 查 关键词 → 确认 1,3, or search keyword → confirm 1,3. Results expire after 2 hours. Up to 10 results are shown, 20 notes can be packed, and the packed file is limited to 20MB.",
      ) });
    }
    new Setting(rules).setName(this.tr("单个附件上限", "Per-attachment limit")).setDesc("1–100 MB").addText((input) => {
      input.inputEl.setAttr("type", "number"); input.inputEl.setAttr("min", "1"); input.inputEl.setAttr("max", "100");
      input.setValue(String(this.plugin.settings.capture.maxFileMb)).onChange(async (value) => {
        this.plugin.settings.capture.maxFileMb = Math.min(100, Math.max(1, Number(value) || 20)); await this.plugin.saveSettings();
      });
    });
    new Setting(rules).setName(this.tr("每篇网页最多保存图片", "Maximum images per clipping")).setDesc(this.tr(
      "默认 30 张；超出的图片保留远程地址，不阻塞后续消息。",
      "Defaults to 30. Extra images keep their remote URLs and do not block later messages.",
    )).addText((input) => {
      input.inputEl.setAttr("type", "number"); input.inputEl.setAttr("min", "1"); input.inputEl.setAttr("max", "100");
      input.setValue(String(this.plugin.settings.capture.maxWebImages)).onChange(async (value) => {
        this.plugin.settings.capture.maxWebImages = Math.min(100, Math.max(1, Number(value) || 30)); await this.plugin.saveSettings();
      });
    });
    new Setting(rules).setName(this.tr("每篇网页图片总量上限", "Total image budget per clipping")).setDesc("1–500 MB").addText((input) => {
      input.inputEl.setAttr("type", "number"); input.inputEl.setAttr("min", "1"); input.inputEl.setAttr("max", "500");
      input.setValue(String(this.plugin.settings.capture.maxWebImageTotalMb)).onChange(async (value) => {
        this.plugin.settings.capture.maxWebImageTotalMb = Math.min(500, Math.max(1, Number(value) || 50)); await this.plugin.saveSettings();
      });
    });
    new Setting(rules).setName(this.tr("单条消息网页处理预算", "Web-processing budget per message")).setDesc(this.tr(
      "15–180 秒，默认 75 秒；到时后保存已完成的正文和图片，其余项目明确标记失败。",
      "15–180 seconds, default 75. Completed text and images are kept; unfinished items are reported explicitly.",
    )).addText((input) => {
      input.inputEl.setAttr("type", "number"); input.inputEl.setAttr("min", "15"); input.inputEl.setAttr("max", "180");
      input.setValue(String(this.plugin.settings.capture.webClipBudgetSeconds)).onChange(async (value) => {
        this.plugin.settings.capture.webClipBudgetSeconds = Math.min(180, Math.max(15, Number(value) || 75)); await this.plugin.saveSettings();
      });
    });
    const codePlatforms = parent.createDiv({ cls: "od-panel" });
    codePlatforms.createEl("h3", { text: this.tr("代码平台地址", "Code-platform links") });
    codePlatforms.createEl("p", { text: this.tr(
      "仓库主页、Issue、PR / MR、Release、Commit、文件页等会先识别平台，再按下面的规则处理。选择“只分类收藏”时不会打开目标网页。",
      "Repository pages, issues, PRs / MRs, releases, commits, and file pages are identified before processing. “File bookmark only” does not open the target page.",
    ) });
    new Setting(codePlatforms)
      .setName(this.tr("处理方式", "Handling mode"))
      .setDesc(this.tr("只影响识别出的代码平台地址；普通网页继续按网页剪藏规则处理。", "Only affects recognized code-platform links. Regular web pages continue to use the web-clipping rules."))
      .addDropdown((dropdown) => dropdown
        .addOptions(this.locale() === "en" ? {
          extract: "Extract page content",
          bookmark: "File bookmark only",
          both: "Extract and file bookmark",
        } : {
          extract: "提取网页正文",
          bookmark: "只分类收藏地址",
          both: "提取正文并分类收藏",
        })
        .setValue(this.plugin.settings.capture.codePlatformMode)
        .onChange(async (value) => {
          this.plugin.settings.capture.codePlatformMode = value;
          await this.plugin.saveSettings();
        }));
    new Setting(codePlatforms)
      .setName(this.tr("附加平台域名", "Additional platform hosts"))
      .setDesc(this.tr(
        "可填写自建 GitLab、Gitea、Forgejo 或公司内部代码平台域名；多个域名用逗号分隔，不要填写令牌。",
        "Add self-hosted GitLab, Gitea, Forgejo, or internal code-platform hosts. Separate hosts with commas and never enter tokens.",
      ))
      .addText((input) => input
        .setPlaceholder("git.example.com, code.example.org")
        .setValue(this.plugin.settings.capture.codePlatformAdditionalHosts)
        .onChange(async (value) => {
          this.plugin.settings.capture.codePlatformAdditionalHosts = value;
          await this.plugin.saveSettings();
        }));
    const codeGrid = codePlatforms.createDiv({ cls: "od-support-grid" });
    for (const [region, titleZh, titleEn] of [["international", "国外平台", "International"], ["china", "国内平台", "China"]]) {
      const group = codeGrid.createDiv({ cls: "od-support-group" });
      group.createEl("h4", { text: this.tr(titleZh, titleEn) });
      const tags = group.createDiv({ cls: "od-support-tags" });
      for (const service of codePlatformCoverage(region)) tags.createSpan({ cls: "od-support-tag is-api", text: service.name });
    }
    const coverage = parent.createDiv({ cls: "od-panel" });
    coverage.createEl("h3", { text: this.tr("技术社区覆盖", "Technical-community coverage") });
    coverage.createEl("p", { text: this.tr(
      "公开接口优先，动态页面使用隔离浏览器，未列出的普通文章仍会尝试通用正文提取。站点改版或登录墙可能导致部分评论暂时不可见。",
      "Public APIs are preferred, dynamic pages use an isolated browser, and unlisted articles still use generic readable-content extraction. Site redesigns or sign-in walls can temporarily hide some comments.",
    ) });
    const coverageGrid = coverage.createDiv({ cls: "od-support-grid" });
    for (const [region, titleZh, titleEn] of [["international", "国外社区", "International"], ["china", "国内社区", "China"]]) {
      const group = coverageGrid.createDiv({ cls: "od-support-group" });
      group.createEl("h4", { text: this.tr(titleZh, titleEn) });
      const tags = group.createDiv({ cls: "od-support-tags" });
      for (const service of communityCoverage(region)) {
        const tag = tags.createSpan({ cls: `od-support-tag ${service.api === "rendered" ? "" : "is-api"}`.trim(), text: service.name });
        tag.setAttr("title", service.api === "rendered" ? this.tr("隔离浏览器 + 通用兜底", "Isolated browser + generic fallback") : this.tr("结构化公开接口 + 浏览器兜底", "Structured public API + browser fallback"));
      }
    }
    const sessions = parent.createDiv({ cls: "od-panel" });
    sessions.createEl("h3", { text: this.tr("私有云文档登录", "Private cloud-document sessions") });
    sessions.createEl("p", { text: this.tr(
      "公开文档无需登录。私有文档请在下面打开插件专用浏览器完成登录；会话只保存在当前 Vault 的 .channel-data，不读取 Chrome 现有 Cookie。登录完成后直接关闭浏览器窗口。",
      "Public documents need no login. For private documents, sign in through the isolated browser below. Its session stays in this Vault's .channel-data and never reads existing Chrome cookies. Close the browser window when finished.",
    ) });
    for (const [id, service] of Object.entries(DOCUMENT_SERVICES)) {
      const row = sessions.createDiv({ cls: "od-session-row" });
      const copy = row.createDiv({ cls: "od-session-copy" });
      copy.createEl("strong", { text: service.name });
      copy.createSpan({ text: this.plugin.webSessionManager.hasSessionData(id)
        ? this.tr("已存在本地会话（仍需由平台确认是否有效）", "Local session data exists (the service still decides whether it remains valid)")
        : this.tr("尚未建立本地会话", "No local session yet") });
      iconButton(row, this.tr("打开登录窗口", "Open sign-in window"), "log-in", async () => {
        try {
          const result = await this.plugin.webSessionManager.openLogin(id, { browserExecutable: this.plugin.settings.capture.browserExecutable });
          new Notice(result.alreadyOpen
            ? this.tr("{name} 登录窗口已打开", "The {name} sign-in window is already open", { name: service.name })
            : this.tr("请在新窗口完成 {name} 登录，完成后关闭窗口", "Sign in to {name} in the new window, then close it", { name: service.name }), 9000);
        } catch (error) {
          new Notice(this.tr("无法打开登录窗口：{error}", "Could not open the sign-in window: {error}", { error: error?.message || error }), 9000);
        }
      }, "is-primary");
    }
    sessions.createEl("h4", { text: this.tr("技术社区浏览器会话", "Technical-community browser sessions") });
    sessions.createEl("p", { text: this.tr(
      "部分社区触发登录或真人验证时，可在对应隔离窗口完成一次验证；插件不会读取你现有浏览器的 Cookie。其他已支持社区默认直接公开提取。",
      "When a community requires sign-in or human verification, complete it once in its isolated window. The plugin never reads existing browser cookies. Other supported communities use public extraction by default.",
    ) });
    for (const [id, service] of Object.entries(COMMUNITY_SERVICES).filter(([, item]) => item.session)) {
      const row = sessions.createDiv({ cls: "od-session-row" });
      const copy = row.createDiv({ cls: "od-session-copy" });
      copy.createEl("strong", { text: service.name });
      copy.createSpan({ text: this.plugin.webSessionManager.hasSessionData(id)
        ? this.tr("已存在本地会话（仍需由平台确认是否有效）", "Local session data exists (the service still decides whether it remains valid)")
        : this.tr("公开提取受限时再建立会话", "Create a session only if public extraction is challenged") });
      iconButton(row, this.tr("打开验证窗口", "Open verification window"), "shield-check", async () => {
        try {
          const result = await this.plugin.webSessionManager.openLogin(id, { browserExecutable: this.plugin.settings.capture.browserExecutable });
          new Notice(result.alreadyOpen
            ? this.tr("{name} 窗口已打开", "The {name} window is already open", { name: service.name })
            : this.tr("请在新窗口完成 {name} 登录或验证，完成后关闭窗口", "Complete {name} sign-in or verification in the new window, then close it", { name: service.name }), 9000);
        } catch (error) {
          new Notice(this.tr("无法打开验证窗口：{error}", "Could not open the verification window: {error}", { error: error?.message || error }), 9000);
        }
      }, "is-primary");
    }
    new Setting(sessions).setName(this.tr("浏览器程序路径（可选）", "Browser executable (optional)")).setDesc(this.tr(
      "默认自动查找 Chrome、Edge、Brave 或 Chromium；只有未找到时才需要填写完整路径。",
      "Chrome, Edge, Brave, or Chromium is detected automatically. Enter a full path only when detection fails.",
    )).addText((input) => input.setPlaceholder(this.locale() === "en" ? "/path/to/chrome" : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome").setValue(this.plugin.settings.capture.browserExecutable).onChange(async (value) => {
      this.plugin.settings.capture.browserExecutable = value.trim();
      await this.plugin.saveSettings();
    }));
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
    points.createEl("li", { text: this.tr("消息正文、网页正文、代码平台收藏和下载成功的附件写入当前 Vault。", "Message text, web articles, code-platform bookmarks, and successfully downloaded attachments are written to the current Vault.") });
    points.createEl("li", { text: this.tr("代码平台选择“只分类收藏地址”时，插件只解析 URL 并写入本地笔记，不访问目标网页。", "When code-platform handling is set to “File bookmark only,” the plugin parses the URL and writes a local note without visiting the target page.") });
    points.createEl("li", { text: this.tr("Bot Token、App Secret、扫码凭据与云文档浏览器会话保存在插件 data.json 或 .channel-data 目录，未做额外加密。", "Bot tokens, app secrets, QR credentials, and cloud-document browser sessions are stored in the plugin's data.json or .channel-data directory without additional encryption.") });
    points.createEl("li", { text: this.tr("默认不扫描收集目录以外的笔记，也不会自动发布任何内容。只有开启「远程查询与导出」后，才会按你设定的文件夹读取 Vault 内 Markdown，用于返回标题、时间、来源和路径，并在确认后打包。", "By default the plugin does not scan notes outside its capture workflow and never publishes content automatically. Only after Remote search and export is enabled does it read Markdown in the chosen folder, return titles, times, sources, and paths, and pack notes after confirmation.") });
    const network = parent.createDiv({ cls: "od-panel od-privacy-panel" });
    network.createEl("h3", { text: this.tr("网络访问", "Network access") });
    network.createEl("p", { text: this.tr(
      "启用哪个渠道，就会连接该平台的官方 API/CDN；剪藏会访问链接、正文图片及动态页面资源域名。localhost、局域网和私有 IP 被阻止。",
      "Enabled channels connect to their official API/CDN. Clipping visits link, article-image, and dynamic-page resource hosts. localhost, local networks, and private IPs are blocked.",
    ) });
    const chips = network.createDiv({ cls: "od-domain-chips" });
    for (const domain of ["github.com / gitlab.com", "gitee.com / gitcode.com", "bitbucket.org / codeberg.org", "dev.azure.com / git.sr.ht", "weixin.qq.com", "xiaohongshu.com / xhslink.cn / xhscdn.com", "feishu.cn / larksuite.com", "docs.qq.com", "kdocs.cn / wps.cn", "reddit.com", "producthunt.com", "dingtalk.com", "work.weixin.qq.com", "qq.com", "slack.com", "telegram.org", "discord.com", "whatsapp.net"]) {
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
