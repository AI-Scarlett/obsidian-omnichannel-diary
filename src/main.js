"use strict";

if (process.argv.includes("--omnichannel-whatsapp-worker")) {
  const { runWhatsAppWorker } = require("./worker/whatsapp");
  runWhatsAppWorker().catch((error) => {
    if (process.send) process.send({ type: "fatal", message: String(error?.message || error) });
    process.exitCode = 1;
  });
} else {
  module.exports = require("./plugin");
}
