"use strict";

const { CHANNEL_IDS } = require("../core/settings");
const { WeChatChannel } = require("./wechat");
const { FeishuChannel } = require("./feishu");
const { DingTalkChannel } = require("./dingtalk");
const { WeComChannel } = require("./wecom");
const { QQChannel } = require("./qq");
const { SlackChannel } = require("./slack");
const { TelegramChannel } = require("./telegram");
const { DiscordChannel } = require("./discord");
const { WhatsAppChannel } = require("./whatsapp");

const CHANNEL_CLASSES = {
  wechat: WeChatChannel,
  feishu: FeishuChannel,
  dingtalk: DingTalkChannel,
  wecom: WeComChannel,
  qq: QQChannel,
  slack: SlackChannel,
  telegram: TelegramChannel,
  discord: DiscordChannel,
  whatsapp: WhatsAppChannel,
};

class ChannelManager {
  constructor(plugin, onMessage) {
    this.plugin = plugin;
    this.onMessage = onMessage;
    this.instances = new Map();
    this.statuses = Object.fromEntries(CHANNEL_IDS.map((id) => [id, { state: "stopped", detail: "未启用" }]));
    this.listeners = new Set();
  }

  context() {
    return {
      onMessage: this.onMessage,
      setStatus: (id, status) => {
        this.statuses[id] = status;
        for (const listener of this.listeners) listener(this.getStatuses());
      },
      saveSettings: () => this.plugin.saveSettings(),
      dataPath: (name) => this.plugin.dataPath(name),
      runtimePath: () => this.plugin.runtimePath(),
    };
  }

  getStatuses() {
    return JSON.parse(JSON.stringify(this.statuses));
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  create(id) {
    const ChannelClass = CHANNEL_CLASSES[id];
    if (!ChannelClass) throw new Error(`Unsupported channel: ${id}`);
    return new ChannelClass(this.plugin.settings.channels[id], this.context());
  }

  async start(id) {
    if (!this.plugin.settings.channels[id]?.enabled) return;
    if (this.instances.has(id)) return;
    const instance = this.create(id);
    this.instances.set(id, instance);
    try {
      await instance.start();
    } catch (error) {
      this.statuses[id] = { state: "error", detail: error?.message || String(error), changedAt: new Date().toISOString() };
      for (const listener of this.listeners) listener(this.getStatuses());
      this.instances.delete(id);
      throw error;
    }
  }

  async stop(id) {
    const instance = this.instances.get(id);
    if (instance) await instance.stop();
    this.instances.delete(id);
    this.statuses[id] = { state: "stopped", detail: this.plugin.settings.channels[id]?.enabled ? "已停止" : "未启用" };
    for (const listener of this.listeners) listener(this.getStatuses());
  }

  async restart(id) {
    await this.stop(id);
    if (this.plugin.settings.channels[id]?.enabled) await this.start(id);
  }

  async startEnabled() {
    for (const id of CHANNEL_IDS) {
      if (!this.plugin.settings.channels[id]?.enabled) continue;
      try { await this.start(id); } catch (_) {}
    }
  }

  async stopAll() {
    await Promise.allSettled([...this.instances.keys()].map((id) => this.stop(id)));
  }

  async pair(id, callbacks) {
    if (!["wechat", "feishu", "whatsapp"].includes(id)) throw new Error("此渠道的官方 Bot 接口不提供扫码授权");
    await this.stop(id);
    this.plugin.settings.channels[id].enabled = true;
    await this.plugin.saveSettings();
    const instance = this.create(id);
    this.instances.set(id, instance);
    try {
      if (id === "feishu") await instance.beginRegistration(callbacks);
      else await instance.beginPairing(callbacks);
      if (id !== "whatsapp") await this.restart(id);
    } catch (error) {
      this.statuses[id] = { state: "error", detail: error?.message || String(error) };
      for (const listener of this.listeners) listener(this.getStatuses());
      throw error;
    }
  }
}

module.exports = { CHANNEL_CLASSES, ChannelManager };
