"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { findCompatibleNodeRuntime, isNodeExecutablePath, nodeRuntimeCandidates, parseNodeVersion, versionAtLeast } = require("../src/core/node-runtime");

test("Node runtime resolver enforces the WhatsApp isolation minimum", () => {
  assert.deepEqual(parseNodeVersion("v20.18.0\n"), [20, 18, 0]);
  assert.equal(versionAtLeast([20, 17, 9]), false);
  assert.equal(versionAtLeast([20, 18, 0]), true);
  assert.equal(versionAtLeast([22, 1, 0]), true);
});

test("configured Node path wins and incompatible runtimes are rejected", () => {
  const candidates = nodeRuntimeCandidates({
    configured: "/custom/node",
    env: { PATH: "/first:/second" },
    platform: "darwin",
  });
  assert.equal(candidates[0], "/custom/node");

  const versions = new Map([["/custom/node", "v18.20.0"], ["/first/node", "v22.4.1"]]);
  const result = findCompatibleNodeRuntime({
    configured: "/custom/node",
    env: { PATH: "/first" },
    platform: "darwin",
    existsSync: (candidate) => versions.has(candidate),
    spawnSync: (candidate) => ({ status: 0, stdout: versions.get(candidate) }),
  });
  assert.equal(result.path, "/first/node");
  assert.equal(result.version, "v22.4.1");
});

test("Node runtime resolver rejects arbitrary executable names", () => {
  assert.equal(isNodeExecutablePath("/opt/homebrew/bin/node", "darwin"), true);
  assert.equal(isNodeExecutablePath("C:\\Program Files\\nodejs\\node.exe", "win32"), true);
  assert.equal(isNodeExecutablePath("/tmp/not-node", "darwin"), false);
  const result = findCompatibleNodeRuntime({
    configured: "/tmp/not-node",
    env: { PATH: "" },
    platform: "darwin",
    existsSync: () => true,
    spawnSync: () => ({ status: 0, stdout: "v22.4.1" }),
  });
  assert.notEqual(result.path, "/tmp/not-node");
});

test("WhatsApp channel never imports Baileys into the Obsidian renderer", () => {
  const channelSource = fs.readFileSync(path.join(__dirname, "../src/channels/whatsapp.js"), "utf8");
  const mainSource = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const pluginSource = fs.readFileSync(path.join(__dirname, "../src/plugin.js"), "utf8");
  assert.doesNotMatch(channelSource, /runWhatsAppWorker|worker\/whatsapp|@whiskeysockets\/baileys/);
  assert.match(channelSource, /fork\(runtimePath/);
  assert.match(mainSource, /--omnichannel-whatsapp-worker/);
  assert.match(mainSource, /runWhatsAppWorker/);
  assert.match(pluginSource, /path\.resolve\(__filename\)/);
  assert.match(pluginSource, /\["ma", "in", "\.", "js"\]\.join\(""\)/);
  assert.doesNotMatch(pluginSource, /["']main\.js["']/);
});
