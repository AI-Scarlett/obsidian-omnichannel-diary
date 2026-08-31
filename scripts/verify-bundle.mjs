import { readFile, stat } from "node:fs/promises";

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const versions = JSON.parse(await readFile("versions.json", "utf8"));
const bundle = await readFile("main.js", "utf8");
const bundleStat = await stat("main.js");
const failures = [];
const maximumSyncFileSize = 5 * 1024 * 1024;

if (manifest.id !== "omnichannel-diary") failures.push("manifest id is not stable");
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) failures.push("manifest version is not x.y.z");
if (manifest.version !== packageJson.version) failures.push("manifest and package versions differ");
if (!versions[manifest.version]) failures.push("versions.json lacks the current version");
if (!/[.!?]$/.test(manifest.description || "")) failures.push("manifest description must end in ASCII punctuation");
if (!bundle.includes("runWhatsAppWorker")) failures.push("WhatsApp bundled runtime is missing");
if (!bundle.includes("omnichannel-whatsapp-worker")) failures.push("WhatsApp isolated process entry is missing");
if (!bundle.includes("nodeRuntimePath")) failures.push("WhatsApp external Node runtime resolution is missing");
if (/ELECTRON_RUN_AS_NODE\s*[:=]\s*["']1["']/.test(bundle)) failures.push("bundle still depends on disabled Electron run-as-node support");
if (bundle.includes("whatsapp.worker.js")) failures.push("bundle still depends on a sibling worker");
if (/createElement\s*\(\s*["']script["']\s*\)/i.test(bundle)) {
  failures.push("bundle dynamically creates a script element");
}
if (/createElementNS\s*\([^)]*,\s*["']script["']\s*\)/i.test(bundle)) {
  failures.push("bundle dynamically creates a namespaced script element");
}
if (/\.setAttribute\s*\(\s*["']src["']\s*,[^)]*\)[^;]{0,500}appendChild/i.test(bundle)) {
  failures.push("bundle contains a dynamic script loading pattern");
}
if (/\beval\s*\(|new\s+Function\s*\(/.test(bundle)) failures.push("bundle contains dynamic code execution");
if (/getconf GNU_LIBC_VERSION|ldd --version/.test(bundle)) failures.push("bundle contains optional dependency shell probes");
if (/createUnzip|extractAllTo|extractEntryTo/i.test(bundle)) failures.push("bundle contains an archive-like extraction signature");
if (bundle.includes("manifest.json")) failures.push("bundle contains a plugin-manifest file target");
if (bundle.includes("main.js")) failures.push("bundle contains a hard-coded plugin-bundle file target");
if (!bundle.trimEnd().endsWith("/* nosourcemap */")) failures.push("bundle is missing the Obsidian nosourcemap footer");
const productionDependencies = Object.keys(packageJson.dependencies || {});
if (productionDependencies.some((name) => /^(?:openai|@anthropic-ai\/)/i.test(name))
  || /(?:api\.openai\.com\/v1|api\.anthropic\.com|OPENAI_API_KEY|ANTHROPIC_API_KEY|new\s+OpenAI\s*\(|new\s+Anthropic\s*\()/i.test(bundle)) {
  failures.push("AI provider code is present");
}
if (bundleStat.size < 10_000) failures.push("bundle is unexpectedly small");
if (bundleStat.size > maximumSyncFileSize) failures.push(`bundle exceeds Obsidian Sync's ${maximumSyncFileSize}-byte file limit`);

if (failures.length) throw new Error(failures.join("\n"));
console.log(`Verified marketplace bundle: ${bundleStat.size} bytes; only main.js is executable.`);
