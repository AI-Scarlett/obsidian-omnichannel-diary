"use strict";

const QRCode = require("qrcode");
const { Modal, Notice, PluginSettingTab, Setting, setIcon } = require("obsidian");
const { CHANNEL_IDS, CHANNEL_META, clearChannelCredentials } = require("../core/settings");
const { shortHash } = require("../core/util");

const SECTIONS = [
  { id: "overview", label: "概览", icon: "layout-dashboard" },
  { id: "channels", label: "渠道", icon: "messages-square" },
  { id: "capture", label: "收集规则", icon: "list-filter" },
  { id: "privacy", label: "存储与隐私", icon: "shield-check" },
];

const CHANNEL_FIELDS = {
  wechat: [],
  feishu: [
    { key: "domain", label: "服务区域", type: "select", options: { feishu: "飞书（中国）", lark: "Lark（国际）" } },
    { key: "appId", label: "App ID", placeholder: "cli_…" },
    { key: "appSecret", label: "App Secret", secret: true },
  ],
  dingtalk: [{ key: "clientId", label: "Client ID" }, { key: "clientSecret", label: "Client Secret", secret: true }],
  wecom: [{ key: "botId", label: "机器人 ID" }, { key: "secret", label: "机器人 Secret", secret: true }],
  qq: [{ key: "appId", label: "App ID" }, { key: "appSecret", label: "App Secret", secret: true }],
  slack: [{ key: "appToken", label: "App Token", placeholder: "xapp-…", secret: true }, { key: "botToken", label: "Bot Token", placeholder: "xoxb-…", secret: true }],
  telegram: [{ key: "botToken", label: "Bot Token", placeholder: "123456:…", secret: true }],
  discord: [{ key: "botToken", label: "Bot Token", secret: true }],
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
    const meta = CHANNEL_META[this.channelId];
    this.titleEl.setText(`连接 ${meta.name}`);
    this.contentEl.addClass("od-pairing-modal");
    const brand = this.contentEl.createDiv({ cls: "od-pair-brand" });
    brand.createDiv({ cls: `od-channel-mark od-channel-${this.channelId}`, text: meta.mark });
    brand.createDiv({ cls: "od-pair-copy" }).createEl("p", { text: "授权只用于接收你发给机器人的内容；凭据保存在当前 Vault 的插件数据中。" });
    this.qrBox = this.contentEl.createDiv({ cls: "od-qr-box od-qr-loading" });
    const spinner = this.qrBox.createDiv({ cls: "od-spinner" });
    spinner.setAttr("aria-label", "正在生成二维码");
    this.statusEl = this.contentEl.createEl("p", { cls: "od-pair-status", text: "正在准备官方连接流程…" });
    this.contentEl.createEl("p", { cls: "od-pair-footnote", text: "二维码由对应平台签发。若平台要求二次确认，请在手机端完成。" });
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
          image.setAttr("alt", `${CHANNEL_META[this.channelId].name} 授权二维码`);
        },
        onStatus: (text) => {
          if (!this.closed) this.statusEl.setText(String(text));
        },
      });
      if (!this.closed) {
        this.statusEl.setText(`${CHANNEL_META[this.channelId].name} 已连接，可以关闭窗口。`);
        this.statusEl.addClass("is-success");
      }
    } catch (error) {
      if (!this.closed) {
        this.statusEl.setText(`连接失败：${error?.message || error}`);
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
    this.titleEl.setText("重新关联 WhatsApp");
    this.contentEl.createEl("p", { text: "当前 Vault 已保存一组 WhatsApp 关联设备凭据。继续后，插件会先停止连接并把原凭据移动到可恢复的备份目录，再生成新的二维码。" });
    this.contentEl.createEl("p", { cls: "od-pair-footnote", text: "此操作不会直接删除旧凭据；若新授权失败，可以从 .channel-data/whatsapp-auth-backups 恢复。" });
    const actions = this.contentEl.createDiv({ cls: "od-modal-actions" });
    iconButton(actions, "取消", "x", () => this.close(), "is-quiet");
    const proceed = iconButton(actions, "备份并重新扫码", "scan-line", async () => {
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
    this.titleEl.setText("保存到 Omnichannel Diary");
    this.contentEl.addClass("od-manual-modal");
    this.contentEl.createEl("p", { text: "粘贴文字或网页链接。链接会按当前收集规则提取正文与图片。" });
    const textarea = this.contentEl.createEl("textarea", { cls: "od-manual-input" });
    textarea.setAttr("rows", "7");
    textarea.setAttr("placeholder", "输入文字，或 https://example.com/article");
    const actions = this.contentEl.createDiv({ cls: "od-modal-actions" });
    iconButton(actions, "取消", "x", () => this.close(), "is-quiet");
    const save = iconButton(actions, "保存", "save", async () => {
      const text = textarea.value.trim();
      if (!text) return;
      save.disabled = true;
      try {
        const result = await this.plugin.router.handle({
          channel: "manual", channelName: "手动收集", id: `manual-${Date.now()}-${shortHash(text)}`,
          timestamp: new Date(), senderId: "local", senderName: "本机", chatName: "Obsidian", text, attachments: [],
        });
        new Notice(`已保存到 ${result.diaryPath}`);
        this.close();
      } catch (error) {
        new Notice(`保存失败：${error?.message || error}`, 7000);
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
    copy.createEl("p", { text: "把聊天里的灵感、网页正文和附件，可靠地沉淀到当前 Obsidian Vault。没有 AI 路由，也不会把笔记上传到中间服务。" });
    const actions = hero.createDiv({ cls: "od-hero-actions" });
    iconButton(actions, "手动保存", "square-pen", () => new ManualCaptureModal(this.app, this.plugin).open(), "is-primary");
    iconButton(actions, "重连渠道", "refresh-cw", async () => {
      await this.plugin.channelManager.stopAll();
      await this.plugin.channelManager.startEnabled();
      new Notice("已重新连接启用的渠道");
    });
  }

  renderNav(nav) {
    for (const section of SECTIONS) {
      const button = nav.createEl("button", { cls: `od-nav-item ${this.activeSection === section.id ? "is-active" : ""}` });
      const icon = button.createSpan();
      setIcon(icon, section.icon);
      button.createSpan({ text: section.label });
      button.addEventListener("click", () => { this.activeSection = section.id; this.render(); });
    }
  }

  sectionHeader(parent, title, description) {
    const header = parent.createDiv({ cls: "od-section-header" });
    header.createEl("h2", { text: title });
    header.createEl("p", { text: description });
  }

  renderOverview(parent) {
    this.sectionHeader(parent, "一眼看清收集状态", "先连接一个渠道，再从对应聊天窗口发送文字、链接或附件。");
    const metrics = parent.createDiv({ cls: "od-metrics" });
    const online = metrics.createDiv({ cls: "od-metric" });
    online.createSpan({ cls: "od-metric-label", text: "在线渠道" });
    this.overviewOnline = online.createEl("strong", { text: "0" });
    online.createSpan({ text: ` / ${CHANNEL_IDS.length}` });
    const enabled = metrics.createDiv({ cls: "od-metric" });
    enabled.createSpan({ cls: "od-metric-label", text: "已启用" });
    enabled.createEl("strong", { text: String(CHANNEL_IDS.filter((id) => this.plugin.settings.channels[id].enabled).length) });
    enabled.createSpan({ text: " 个" });
    const local = metrics.createDiv({ cls: "od-metric od-metric-wide" });
    local.createSpan({ cls: "od-metric-label", text: "日记目录" });
    local.createEl("code", { text: this.plugin.settings.storage.diaryFolder });

    const steps = parent.createDiv({ cls: "od-panel" });
    steps.createEl("h3", { text: "三步开始" });
    const list = steps.createDiv({ cls: "od-step-list" });
    for (const [number, title, text] of [
      ["01", "选择渠道", "扫码授权，或填入平台签发的 Bot 凭据。"],
      ["02", "发送内容", "文字写入日记；链接额外生成正文剪藏；附件保存到本地目录。"],
      ["03", "回到 Obsidian", "每天一篇日记，来源、失败项和本地附件都有明确记录。"],
    ]) {
      const step = list.createDiv({ cls: "od-step" });
      step.createSpan({ cls: "od-step-number", text: number });
      const body = step.createDiv();
      body.createEl("strong", { text: title });
      body.createEl("p", { text });
    }

    const quick = parent.createDiv({ cls: "od-panel" });
    quick.createEl("h3", { text: "渠道速览" });
    const grid = quick.createDiv({ cls: "od-mini-grid" });
    for (const id of CHANNEL_IDS) {
      const meta = CHANNEL_META[id];
      const item = grid.createDiv({ cls: "od-mini-channel" });
      item.createSpan({ cls: `od-mini-mark od-channel-${id}`, text: meta.mark });
      item.createSpan({ text: meta.name });
      const state = item.createSpan({ cls: "od-state-dot" });
      this.statusElements.set(id, { dot: state });
    }
  }

  renderChannels(parent) {
    this.sectionHeader(parent, "连接聊天渠道", "微信、飞书/Lark 与 WhatsApp 支持扫码流程；其他平台的 Bot API 按官方规则使用应用凭据。");
    const grid = parent.createDiv({ cls: "od-channel-grid" });
    for (const id of CHANNEL_IDS) this.renderChannelCard(grid, id);
  }

  renderChannelCard(grid, id) {
    const meta = CHANNEL_META[id];
    const config = this.plugin.settings.channels[id];
    const card = grid.createEl("details", { cls: `od-channel-card od-channel-${id}` });
    const summary = card.createEl("summary");
    summary.createSpan({ cls: "od-channel-mark", text: meta.mark });
    const title = summary.createDiv({ cls: "od-channel-title" });
    title.createEl("strong", { text: meta.name });
    title.createSpan({ text: meta.setup });
    const badge = summary.createSpan({ cls: "od-status-badge", text: "未启用" });
    this.statusElements.set(id, { badge });
    const body = card.createDiv({ cls: "od-channel-body" });
    new Setting(body).setName("启用此渠道").setDesc("Obsidian 打开时自动连接").addToggle((toggle) => toggle.setValue(Boolean(config.enabled)).onChange(async (value) => {
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
      const label = id === "feishu" ? "扫码创建应用" : hasWhatsAppAuth ? "重新扫码" : "扫码连接";
      iconButton(actions, label, "scan-line", () => {
        if (hasWhatsAppAuth) new WhatsAppReconnectModal(this.app, this.plugin).open();
        else new PairingModal(this.app, this.plugin, id).open();
      }, "is-primary");
    }
    if (SETUP_LINKS[id]) iconButton(actions, "打开官方设置", "external-link", () => window.open(SETUP_LINKS[id], "_blank", "noopener,noreferrer"), "is-quiet");
    iconButton(actions, "测试重连", "plug-zap", async () => {
      try { await this.plugin.channelManager.restart(id); new Notice(`${meta.name} 已发起重连`); }
      catch (error) { new Notice(`${meta.name}：${error?.message || error}`, 8000); }
    });
    const runtime = body.createEl("p", { cls: "od-channel-runtime", text: "当前未启用" });
    this.statusElements.get(id).runtime = runtime;
    const note = body.createEl("p", { cls: "od-channel-note" });
    if (id === "wechat") note.setText("使用微信官方 iLink / ClawBot 授权，不是网页登录或设备模拟。功能是否可用取决于微信账号的开放范围。");
    else if (id === "whatsapp") note.setText("通过 WhatsApp 官方“已关联设备”扫码。现有授权会直接重连；重新扫码前会先把旧凭据移入可恢复备份。");
    else if (["telegram", "discord", "slack"].includes(id)) note.setText("该平台的官方 Bot 接口不提供个人账号扫码接入；请从官方开发者入口创建 Bot 并粘贴令牌。");
    else note.setText("使用平台官方长连接 / Stream 接口，无需公网回调地址。");
  }

  renderChannelField(parent, config, field) {
    const setting = new Setting(parent).setName(field.label);
    if (field.type === "select") {
      setting.addDropdown((dropdown) => dropdown.addOptions(field.options).setValue(config[field.key]).onChange(async (value) => {
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
    this.sectionHeader(parent, "决定内容怎样落盘", "规则是确定性的；不调用模型，不对消息做语义判断。");
    const storage = parent.createDiv({ cls: "od-panel" });
    storage.createEl("h3", { text: "Vault 目录" });
    for (const [key, name, desc] of [
      ["diaryFolder", "每日笔记", "按本地日期生成 YYYY-MM-DD.md"],
      ["clippingFolder", "网页剪藏", "正文与来源元数据"],
      ["attachmentFolder", "本地附件", "聊天附件与网页图片分目录保存"],
    ]) {
      new Setting(storage).setName(name).setDesc(desc).addText((input) => input.setValue(this.plugin.settings.storage[key]).onChange(async (value) => {
        this.plugin.settings.storage[key] = value.trim(); await this.plugin.saveSettings();
      }));
    }
    const rules = parent.createDiv({ cls: "od-panel" });
    rules.createEl("h3", { text: "收集规则" });
    this.addToggle(rules, "自动剪藏网页", "检测消息中的 HTTP(S) 链接并保存可读正文", "autoClipLinks");
    this.addToggle(rules, "保存网页图片", "把正文图片下载到 Vault；失败时保留远程地址并写明数量", "downloadWebImages");
    this.addToggle(rules, "保存聊天附件", "图片、文件、音频和视频按渠道保存", "downloadChatAttachments");
    this.addToggle(rules, "收集群聊消息", "关闭后只保存私聊", "includeGroupMessages");
    this.addToggle(rules, "群聊必须提及机器人", "减少群聊噪声；需要平台提供 mention 信息", "requireMentionInGroups");
    new Setting(rules).setName("单个附件上限").setDesc("1–100 MB").addText((input) => {
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
    this.sectionHeader(parent, "数据边界清清楚楚", "插件没有遥测、账户系统、代理服务器或 AI 服务；但已启用渠道必须连接对应平台。");
    const local = parent.createDiv({ cls: "od-panel od-privacy-panel" });
    local.createEl("h3", { text: "本地保存" });
    const points = local.createEl("ul");
    points.createEl("li", { text: "消息正文、网页正文和下载成功的附件写入当前 Vault。" });
    points.createEl("li", { text: "Bot Token、App Secret 和扫码会话凭据保存在插件 data.json 或 .channel-data 目录，未做额外加密。" });
    points.createEl("li", { text: "插件不会扫描与收集目录无关的笔记，也不会自动发布任何内容。" });
    const network = parent.createDiv({ cls: "od-panel od-privacy-panel" });
    network.createEl("h3", { text: "网络访问" });
    network.createEl("p", { text: "启用哪个渠道，就会连接该平台的官方 API/CDN；剪藏链接时会访问链接域名及正文图片域名。localhost、局域网和私有 IP 被阻止。" });
    const chips = network.createDiv({ cls: "od-domain-chips" });
    for (const domain of ["weixin.qq.com", "feishu.cn / larksuite.com", "dingtalk.com", "work.weixin.qq.com", "qq.com", "slack.com", "telegram.org", "discord.com", "whatsapp.net"]) {
      chips.createEl("code", { text: domain });
    }
    const credentials = parent.createDiv({ cls: "od-panel" });
    credentials.createEl("h3", { text: "清除渠道凭据" });
    credentials.createEl("p", { text: "会停止渠道并从 data.json 删除该渠道的已保存字段。WhatsApp 的关联设备文件需要在插件目录 .channel-data 中手动删除，确保不会误删当前登录。" });
    const buttons = credentials.createDiv({ cls: "od-clear-grid" });
    for (const id of CHANNEL_IDS.filter((value) => value !== "whatsapp")) {
      iconButton(buttons, CHANNEL_META[id].name, "key-round", async () => {
        await this.plugin.channelManager.stop(id);
        clearChannelCredentials(this.plugin.settings, id);
        await this.plugin.saveSettings();
        new Notice(`${CHANNEL_META[id].name} 凭据已清除`);
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
        elements.badge.setText(state === "connected" ? "已连接" : state === "connecting" ? "连接中" : state === "pairing" ? "待扫码" : state === "error" ? "需处理" : "未启用");
        elements.badge.setAttr("title", value.detail || "");
      }
      if (elements.runtime) {
        elements.runtime.setAttr("data-state", state);
        elements.runtime.setText(value.detail || (state === "connected" ? "连接正常" : state === "error" ? "连接异常" : "当前未启用"));
      }
    }
    if (this.overviewOnline) this.overviewOnline.setText(String(online));
  }
}

module.exports = { DiarySettingTab, ManualCaptureModal, PairingModal };
