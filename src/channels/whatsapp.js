"use strict";

const { fork } = require("node:child_process");
const { BaseChannel } = require("./base");

const WHATSAPP_WORKER_FLAG = "--omnichannel-whatsapp-worker";
const COMMAND_TIMEOUT_MS = 45_000;

function isolatedProcessError(t, detail = "") {
  const suffix = detail ? ` (${detail})` : "";
  return new Error(t(
    `WhatsApp 独立进程已退出${suffix}；Obsidian 仍可继续使用，请在渠道设置中测试重连`,
    `The isolated WhatsApp process exited${suffix}. Obsidian remains usable; test reconnection in channel settings`,
  ));
}

class WhatsAppChannel extends BaseChannel {
  constructor(config, context) {
    super("whatsapp", config, context);
    this.child = null;
    this.pairingCallbacks = null;
    this.pairingRequest = null;
    this.commandSequence = 0;
  }

  spawn() {
    if (this.child) return this.child;
    const authDir = this.context.dataPath("whatsapp-auth");
    const runtimePath = this.context.runtimePath?.();
    const nodeRuntimePath = this.context.nodeRuntimePath?.();
    if (!runtimePath || !nodeRuntimePath) {
      throw new Error(this.t("WhatsApp 独立运行环境不可用", "The isolated WhatsApp runtime is unavailable"));
    }
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    const child = fork(runtimePath, [WHATSAPP_WORKER_FLAG], {
      execPath: nodeRuntimePath,
      env: environment,
      serialization: "json",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      windowsHide: true,
    });
    const runtime = {
      process: child,
      pending: new Map(),
      stopping: false,
      stderr: "",
      exited: false,
      postMessage: (message, timeoutMs = COMMAND_TIMEOUT_MS) => this.postWorkerMessage(runtime, message, timeoutMs),
    };
    runtime.done = new Promise((resolve) => { runtime.resolveDone = resolve; });
    this.child = runtime;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      runtime.stderr = `${runtime.stderr}${chunk}`.slice(-4_000);
    });
    child.on("message", (packet) => void this.onWorkerMessage(packet, runtime));
    child.once("error", (error) => this.onWorkerExit(runtime, null, null, error));
    child.once("exit", (code, signal) => this.onWorkerExit(runtime, code, signal));
    child.send({ type: "init", authDir, locale: this.locale() }, (error) => {
      if (error) this.onWorkerExit(runtime, null, null, error);
    });
    return runtime;
  }

  postWorkerMessage(runtime, message, timeoutMs) {
    if (!runtime || runtime.exited || !runtime.process.connected) {
      return Promise.reject(new Error(this.t("WhatsApp 连接不可用", "WhatsApp connection unavailable")));
    }
    const requestId = `${Date.now().toString(36)}-${++this.commandSequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        runtime.pending.delete(requestId);
        reject(new Error(this.t("WhatsApp 独立进程响应超时", "The isolated WhatsApp process timed out")));
      }, timeoutMs);
      runtime.pending.set(requestId, { resolve, reject, timer });
      runtime.process.send({ ...message, requestId }, (error) => {
        if (!error) return;
        clearTimeout(timer);
        runtime.pending.delete(requestId);
        reject(error);
      });
    });
  }

  onWorkerExit(runtime, code, signal, cause) {
    if (runtime.exited) return;
    runtime.exited = true;
    runtime.resolveDone?.({ code, signal });
    const detail = cause?.message || (signal ? `signal ${signal}` : Number.isInteger(code) ? `code ${code}` : "");
    const error = isolatedProcessError((zh, en) => this.t(zh, en), detail);
    for (const request of runtime.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    runtime.pending.clear();
    if (this.child === runtime) this.child = null;
    if (runtime.stopping || !this.running) return;
    this.setState("error", error.message);
    this.pairingCallbacks?.onStatus?.(error.message);
    this.settlePairing(error);
  }

  settlePairing(error) {
    const request = this.pairingRequest;
    if (!request) return;
    clearTimeout(request.timer);
    this.pairingRequest = null;
    if (error) request.reject(error);
    else request.resolve(this.config);
  }

  async onWorkerMessage(packet, runtime = this.child) {
    if (!runtime || runtime !== this.child) return;
    if (packet?.type === "command-result") {
      const request = runtime.pending.get(packet.requestId);
      if (!request) return;
      clearTimeout(request.timer);
      runtime.pending.delete(packet.requestId);
      if (packet.ok) request.resolve(packet.value);
      else request.reject(new Error(packet.error || this.t("WhatsApp 操作失败", "WhatsApp operation failed")));
      return;
    }
    if (packet?.type === "qr") {
      this.setState("pairing", this.t("等待 WhatsApp 扫码", "Waiting for WhatsApp QR scan"));
      this.pairingCallbacks?.onQr?.(packet.value);
      this.pairingCallbacks?.onStatus?.(this.t("打开 WhatsApp → 设置 → 已关联设备 → 关联设备，然后扫码", "Open WhatsApp → Settings → Linked Devices → Link a Device, then scan the QR code"));
      return;
    }
    if (packet?.type === "status") {
      this.setState(packet.state, packet.detail || "");
      this.pairingCallbacks?.onStatus?.(packet.detail || packet.state);
      if (packet.state === "connected") this.settlePairing();
      if (packet.state === "error") this.settlePairing(new Error(packet.detail || this.t("WhatsApp 连接失败", "WhatsApp connection failed")));
      return;
    }
    if (packet?.type === "fatal") {
      const message = packet.message || this.t("WhatsApp 连接失败", "WhatsApp connection failed");
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
      } : { fileName: item.fileName, load: async () => { throw new Error(item.error || this.t("WhatsApp 附件不可用", "WhatsApp attachment unavailable")); } }),
      reply: async (text) => {
        if (!this.child) throw new Error(this.t("WhatsApp 连接不可用", "WhatsApp connection unavailable"));
        await this.child.postMessage({ type: "reply", jid: value.replyTarget, text });
      },
    });
  }

  async beginPairing(callbacks = {}) {
    this.pairingCallbacks = callbacks;
    if (this.child) await this.stopChild();
    this.running = true;
    callbacks.onStatus?.(this.t("正在独立进程中启动 WhatsApp 官方关联设备流程…", "Starting the official WhatsApp linked-device flow in an isolated process…"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.settlePairing(new Error(this.t("WhatsApp 扫码等待超时，请重新生成二维码", "WhatsApp QR scan timed out. Generate a new QR code"))), 8 * 60_000);
      this.pairingRequest = { resolve, reject, timer };
      try { this.spawn(); }
      catch (error) { this.settlePairing(error); }
    });
  }

  async start() {
    this.running = true;
    this.setState("connecting", this.t("正在独立进程中启动 WhatsApp", "Starting WhatsApp in an isolated process"));
    try { this.spawn(); }
    catch (error) {
      this.running = false;
      this.setState("error", error?.message || String(error));
      throw error;
    }
  }

  async stop() {
    this.running = false;
    this.settlePairing(new Error(this.t("WhatsApp 连接已取消", "WhatsApp connection cancelled")));
    await this.stopChild();
    this.pairingCallbacks = null;
    this.setState("stopped");
  }

  async stopChild() {
    const runtime = this.child;
    if (!runtime) return;
    runtime.stopping = true;
    try { await runtime.postMessage({ type: "stop" }, 2_000); } catch (_) {}
    await Promise.race([runtime.done, new Promise((resolve) => setTimeout(resolve, 1_500))]);
    if (!runtime.exited) runtime.process.kill("SIGTERM");
    await Promise.race([runtime.done, new Promise((resolve) => setTimeout(resolve, 750))]);
    if (!runtime.exited) runtime.process.kill("SIGKILL");
    if (this.child === runtime) this.child = null;
  }
}

module.exports = { COMMAND_TIMEOUT_MS, WHATSAPP_WORKER_FLAG, WhatsAppChannel, isolatedProcessError };
