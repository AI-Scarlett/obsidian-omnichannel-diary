"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const MINIMUM_NODE_VERSION = [20, 18, 0];

function isNodeExecutablePath(value, platform = process.platform) {
  const expected = platform === "win32" ? "node.exe" : "node";
  const basename = platform === "win32" ? path.win32.basename(String(value || "")) : path.basename(String(value || ""));
  return basename.toLowerCase() === expected;
}

function parseNodeVersion(value) {
  const match = String(value || "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map((part) => Number.parseInt(part, 10)) : null;
}

function versionAtLeast(actual, minimum = MINIMUM_NODE_VERSION) {
  if (!actual) return false;
  for (let index = 0; index < minimum.length; index += 1) {
    if ((actual[index] || 0) > minimum[index]) return true;
    if ((actual[index] || 0) < minimum[index]) return false;
  }
  return true;
}

function nodeRuntimeCandidates(options = {}) {
  const platform = options.platform || process.platform;
  const environment = options.env || process.env;
  const executable = platform === "win32" ? "node.exe" : "node";
  const configured = String(options.configured || "").trim();
  const candidates = [configured, String(environment.OMNICHANNEL_DIARY_NODE || "").trim()];
  const pathValue = environment.PATH || environment.Path || environment.path || "";
  const delimiter = platform === "win32" ? ";" : ":";
  for (const directory of String(pathValue).split(delimiter).filter(Boolean)) {
    candidates.push(path.join(directory, executable));
  }
  if (platform === "darwin") {
    candidates.push("/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node");
  } else if (platform === "linux") {
    candidates.push("/usr/local/bin/node", "/usr/bin/node", "/snap/bin/node");
  } else if (platform === "win32") {
    for (const root of [environment.ProgramFiles, environment["ProgramFiles(x86)"], environment.LOCALAPPDATA]) {
      if (root) candidates.push(path.join(root, "nodejs", "node.exe"));
    }
  }
  return [...new Set(candidates.filter(Boolean).map((value) => path.resolve(value)))];
}

function findCompatibleNodeRuntime(options = {}) {
  const existsSync = options.existsSync || fs.existsSync;
  const run = options.spawnSync || spawnSync;
  const rejected = [];
  for (const candidate of nodeRuntimeCandidates(options)) {
    if (!isNodeExecutablePath(candidate, options.platform)) continue;
    if (!existsSync(candidate)) continue;
    let result;
    try {
      result = run(candidate, ["--version"], {
        encoding: "utf8",
        timeout: 3_000,
        windowsHide: true,
      });
    } catch (_) {
      continue;
    }
    const versionText = String(result?.stdout || "").trim();
    const version = parseNodeVersion(versionText);
    if (result?.status === 0 && versionAtLeast(version)) return { path: candidate, version: versionText };
    if (versionText) rejected.push(`${candidate} (${versionText})`);
  }
  return { path: "", version: "", rejected };
}

module.exports = { MINIMUM_NODE_VERSION, findCompatibleNodeRuntime, isNodeExecutablePath, nodeRuntimeCandidates, parseNodeVersion, versionAtLeast };
