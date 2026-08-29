import { readFile, stat } from "node:fs/promises";

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const versions = JSON.parse(await readFile("versions.json", "utf8"));
const bundle = await readFile("main.js", "utf8");
const bundleStat = await stat("main.js");
const failures = [];

if (manifest.id !== "omnichannel-diary") failures.push("manifest id is not stable");
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) failures.push("manifest version is not x.y.z");
if (manifest.version !== packageJson.version) failures.push("manifest and package versions differ");
if (!versions[manifest.version]) failures.push("versions.json lacks the current version");
if (!bundle.includes("runWhatsAppWorker")) failures.push("WhatsApp bundled runtime is missing");
if (bundle.includes("omnichannel-whatsapp-worker")) failures.push("bundle still starts WhatsApp through a V8 worker entry");
if (bundle.includes("ELECTRON_RUN_AS_NODE")) failures.push("bundle still depends on disabled Electron run-as-node support");
if (bundle.includes("whatsapp.worker.js")) failures.push("bundle still depends on a sibling worker");
if (/\b(openai|anthropic)\b/i.test(bundle)) failures.push("AI provider code is present");
if (bundleStat.size < 10_000) failures.push("bundle is unexpectedly small");

if (failures.length) throw new Error(failures.join("\n"));
console.log(`Verified marketplace bundle: ${bundleStat.size} bytes; only main.js is executable.`);
