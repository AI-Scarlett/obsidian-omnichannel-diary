"use strict";

const { getChannelMeta } = require("../core/settings");
const { translate } = require("../core/i18n");
const { toErrorMessage } = require("../core/util");

class BaseChannel {
  constructor(id, config, context) {
    this.id = id;
    this.config = config;
    this.context = context;
    this.running = false;
  }

  setState(state, detail = "") {
    this.context.setStatus(this.id, { state, detail, changedAt: new Date().toISOString() });
  }

  locale() {
    return this.context.getLocale?.() || "zh-CN";
  }

  t(zh, en, values = {}) {
    return this.context.t?.(zh, en, values) || translate(this.locale(), zh, en, values);
  }

  meta() {
    return getChannelMeta(this.id, this.locale());
  }

  assertFields(fields) {
    const missing = fields.filter((key) => !String(this.config[key] || "").trim());
    if (missing.length) throw new Error(this.t("缺少设置：{fields}", "Missing settings: {fields}", { fields: missing.join(", ") }));
  }

  async deliver(envelope) {
    try {
      const result = await this.context.onMessage({
        channel: this.id,
        channelName: this.meta().name,
        timestamp: new Date(),
        attachments: [],
        ...envelope,
      });
      return { ok: true, result };
    } catch (error) {
      this.setState("error", this.t("消息处理失败：{error}", "Message processing failed: {error}", { error: toErrorMessage(error) }));
      return { ok: false, error };
    }
  }

  async start() {
    this.running = true;
    this.setState("connected");
  }

  async stop() {
    this.running = false;
    this.setState("stopped");
  }
}

module.exports = { BaseChannel };
