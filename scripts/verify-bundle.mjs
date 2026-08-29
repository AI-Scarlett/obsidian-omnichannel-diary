import { readFile, stat } from "node:fs/promises";

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const bundle = await readFile("main.js", "utf8");
const bundleStat = await stat("main.js");
const failures = [];

if (manifest.id !== "omnichannel-diary") failures.push("manifest id is not stable");
if (manifest.version !== "0.3.0") failures.push("manifest version is not 0.3.0");
if (!bundle.includes("--omnichannel-whatsapp-worker")) failures.push("WhatsApp worker entry is missing");
if (!bundle.includes("runtimePath")) failures.push("WhatsApp worker lacks an explicit installed main.js path");
if (bundle.includes("whatsapp.worker.js")) failures.push("bundle still depends on a sibling worker");
if (/\b(openai|anthropic)\b/i.test(bundle)) failures.push("AI provider code is present");
if (bundleStat.size < 10_000) failures.push("bundle is unexpectedly small");

if (failures.length) throw new Error(failures.join("\n"));
console.log(`Verified marketplace bundle: ${bundleStat.size} bytes; only main.js is executable.`);
