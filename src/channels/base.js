"use strict";

const { CHANNEL_META } = require("../core/settings");
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

  assertFields(fields) {
    const missing = fields.filter((key) => !String(this.config[key] || "").trim());
    if (missing.length) throw new Error(`Missing settings: ${missing.join(", ")}`);
  }

  async deliver(envelope) {
    try {
      const result = await this.context.onMessage({
        channel: this.id,
        channelName: CHANNEL_META[this.id].name,
        timestamp: new Date(),
        attachments: [],
        ...envelope,
      });
      return { ok: true, result };
    } catch (error) {
      this.setState("error", `消息处理失败：${toErrorMessage(error)}`);
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
