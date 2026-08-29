"use strict";

const { BaseChannel } = require("./base");
const { runWhatsAppWorker } = require("../worker/whatsapp");

class WhatsAppChannel extends BaseChannel {
  constructor(config, context) {
    super("whatsapp", config, context);
    this.child = null;
    this.pairingCallbacks = null;
    this.pairingRequest = null;
  }

  spawn() {
    if (this.child) return this.child;
    const authDir = this.context.dataPath("whatsapp-auth");
    const runtime = {
      handler: null,
      queue: [],
      postMessage(message) {
        if (this.handler) void this.handler(message);
        else this.queue.push(message);
      },
    };
    this.child = runtime;
    runtime.done = runWhatsAppWorker({
      authDir,
      send: (packet) => void this.onWorkerMessage(packet),
      onMessage: (handler) => {
        runtime.handler = handler;
        for (const message of runtime.queue.splice(0)) void handler(message);
      },
      stop() {},
    }).catch((error) => {
      if (this.child === runtime) this.child = null;
      this.setState("error", error.message);
      this.pairingCallbacks?.onStatus?.(error.message);
      this.settlePairing(error);
    });
    return runtime;
  }

  settlePairing(error) {
    const request = this.pairingRequest;
    if (!request) return;
    clearTimeout(request.timer);
    this.pairingRequest = null;
    if (error) request.reject(error);
    else request.resolve(this.config);
  }

  async onWorkerMessage(packet) {
    if (packet?.type === "qr") {
      this.setState("pairing", "等待 WhatsApp 扫码");
      this.pairingCallbacks?.onQr?.(packet.value);
      this.pairingCallbacks?.onStatus?.("打开 WhatsApp → 设置 → 已关联设备 → 关联设备，然后扫码");
      return;
    }
    if (packet?.type === "status") {
      this.setState(packet.state, packet.detail || "");
      this.pairingCallbacks?.onStatus?.(packet.detail || packet.state);
      if (packet.state === "connected") this.settlePairing();
      if (packet.state === "error") this.settlePairing(new Error(packet.detail || "WhatsApp 连接失败"));
      return;
    }
    if (packet?.type === "fatal") {
      const message = packet.message || "WhatsApp 连接失败";
      this.setState("error", message);
      this.pairingCallbacks?.onStatus?.(message);
      this.settlePairing(new Error(message));
      return;
    }
    if (packet?.type !== "message") return;
    const value = packet.value || {};
    await this.deliver({
      ...value,
      timestamp: new Date(value.timestamp || Date.now()),
      attachments: (value.attachments || []).map((item) => item.base64 ? {
        fileName: item.fileName,
        mimeType: item.mimeType,
        buffer: Buffer.from(item.base64, "base64"),
      } : { fileName: item.fileName, load: async () => { throw new Error(item.error || "WhatsApp 附件不可用"); } }),
      reply: async (text) => this.child?.postMessage({ type: "reply", jid: value.replyTarget, text }),
    });
  }

  async beginPairing(callbacks = {}) {
    this.pairingCallbacks = callbacks;
    if (this.child) {
      await this.stopChild();
    }
    this.running = true;
    callbacks.onStatus?.("正在启动 WhatsApp 官方关联设备流程…");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.settlePairing(new Error("WhatsApp 扫码等待超时，请重新生成二维码")), 8 * 60_000);
      this.pairingRequest = { resolve, reject, timer };
      try { this.spawn(); }
      catch (error) { this.settlePairing(error); }
    });
  }

  async start() {
    this.running = true;
    this.setState("connecting", "正在启动 WhatsApp 内置连接");
    this.spawn();
  }

  async stop() {
    this.running = false;
    this.settlePairing(new Error("WhatsApp 连接已取消"));
    await this.stopChild();
    this.pairingCallbacks = null;
    this.setState("stopped");
  }

  async stopChild() {
    const runtime = this.child;
    if (!runtime) return;
    runtime.postMessage({ type: "stop" });
    await Promise.race([runtime.done, new Promise((resolve) => setTimeout(resolve, 1_500))]);
    if (this.child === runtime) this.child = null;
  }
}

module.exports = { WhatsAppChannel };
