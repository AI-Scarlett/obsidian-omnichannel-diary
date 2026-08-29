"use strict";

const { fork } = require("node:child_process");
const { BaseChannel } = require("./base");

class WhatsAppChannel extends BaseChannel {
  constructor(config, context) {
    super("whatsapp", config, context);
    this.child = null;
    this.pairingCallbacks = null;
  }

  spawn() {
    if (this.child) return;
    const authDir = this.context.dataPath("whatsapp-auth");
    this.child = fork(this.context.runtimePath(), ["--omnichannel-whatsapp-worker", "--auth-dir", authDir], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    this.child.on("message", (packet) => void this.onWorkerMessage(packet));
    this.child.on("error", (error) => this.setState("error", error.message));
    this.child.on("exit", (code) => {
      this.child = null;
      if (this.running && code !== 0) this.setState("error", `WhatsApp 子进程退出（${code ?? "unknown"}）`);
    });
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
      return;
    }
    if (packet?.type === "fatal") {
      this.setState("error", packet.message || "WhatsApp 连接失败");
      this.pairingCallbacks?.onStatus?.(packet.message || "WhatsApp 连接失败");
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
      reply: async (text) => this.child?.send({ type: "reply", jid: value.replyTarget, text }),
    });
  }

  async beginPairing(callbacks = {}) {
    this.pairingCallbacks = callbacks;
    if (this.child) {
      callbacks.onStatus?.("正在重新生成 WhatsApp 二维码…");
      this.child.send({ type: "stop" });
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    this.running = true;
    this.spawn();
  }

  async start() {
    this.running = true;
    this.setState("connecting", "正在启动 WhatsApp 隔离进程");
    this.spawn();
  }

  async stop() {
    this.running = false;
    if (this.child?.connected) this.child.send({ type: "stop" });
    const child = this.child;
    setTimeout(() => child?.kill(), 1_500);
    this.child = null;
    this.pairingCallbacks = null;
    this.setState("stopped");
  }
}

module.exports = { WhatsAppChannel };
