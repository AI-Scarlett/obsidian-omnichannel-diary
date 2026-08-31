"use strict";

const WHATSAPP_WORKER_FLAG = "--omnichannel-whatsapp-worker";

function sendToParent(packet) {
  if (!process.connected || typeof process.send !== "function") return;
  try { process.send(packet); } catch (_) {}
}

async function runWhatsAppProcess() {
  const { runWhatsAppWorker } = require("./worker/whatsapp");
  let initialized = false;
  let commandHandler = null;
  let stopping = false;
  const commandQueue = [];

  const handleCommand = async (packet) => {
    const requestId = packet?.requestId;
    try {
      await commandHandler(packet);
      if (requestId) sendToParent({ type: "command-result", requestId, ok: true });
    } catch (error) {
      if (requestId) sendToParent({ type: "command-result", requestId, ok: false, error: error?.message || String(error) });
    }
  };

  const stopForDisconnect = () => {
    if (stopping) return;
    stopping = true;
    if (commandHandler) void commandHandler({ type: "stop" });
    setTimeout(() => process.exit(0), 1_500).unref();
  };

  process.on("disconnect", stopForDisconnect);
  process.on("SIGTERM", stopForDisconnect);
  process.on("SIGINT", stopForDisconnect);
  process.on("message", (packet) => {
    if (packet?.type === "init" && !initialized) {
      initialized = true;
      void runWhatsAppWorker({
        authDir: packet.authDir,
        locale: packet.locale,
        send: sendToParent,
        onMessage: (handler) => {
          commandHandler = handler;
          for (const queued of commandQueue.splice(0)) void handleCommand(queued);
        },
        stop() {},
      }).catch((error) => {
        sendToParent({ type: "fatal", message: error?.message || String(error) });
        process.exitCode = 1;
      }).finally(() => {
        if (process.connected) process.disconnect();
      });
      return;
    }
    if (!packet?.requestId) return;
    if (commandHandler) void handleCommand(packet);
    else commandQueue.push(packet);
  });
  sendToParent({ type: "worker-ready" });
}

if (process.argv.includes(WHATSAPP_WORKER_FLAG)) {
  void runWhatsAppProcess();
} else {
  module.exports = require("./plugin");
}
