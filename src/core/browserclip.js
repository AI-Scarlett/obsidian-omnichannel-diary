"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const WebSocket = require("ws");
const { validateResolvedHost } = require("./network");
const { COMMUNITY_SERVICES, RENDER_SERVICES } = require("./web-platforms");

const KNOWN_BROWSER_PATHS = process.platform === "darwin" ? [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
] : process.platform === "win32" ? [
  path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Google/Chrome/Application/chrome.exe"),
  path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Microsoft/Edge/Application/msedge.exe"),
  path.join(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe"),
] : ["/usr/bin/google-chrome", "/usr/bin/microsoft-edge", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/brave-browser"];

function findBrowserExecutable(override = "") {
  const requested = String(override || "").trim();
  if (requested) {
    if (!fs.existsSync(requested)) throw new Error(`Configured browser was not found: ${requested}`);
    return requested;
  }
  const found = KNOWN_BROWSER_PATHS.find((candidate) => candidate && fs.existsSync(candidate));
  if (!found) throw new Error("No supported local Chrome, Edge, Brave, or Chromium browser was found");
  return found;
}

function freeLocalPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function httpJson(url, method = "GET") {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        if ((response.statusCode || 0) >= 400) return reject(new Error(`Browser debugging endpoint returned HTTP ${response.statusCode}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch (error) { reject(error); }
      });
    });
    request.once("error", reject);
    request.setTimeout(2_000, () => request.destroy(new Error("Browser debugging endpoint timed out")));
    request.end();
  });
}

async function waitForDebugger(port, child, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Browser exited before startup (code ${child.exitCode})`);
    try { return await httpJson(`http://127.0.0.1:${port}/json/version`); }
    catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 180));
  }
  throw lastError || new Error("Browser startup timed out");
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    socket.on("message", (raw) => this.onMessage(raw));
    socket.on("close", () => this.failPending(new Error("Browser debugging connection closed")));
    socket.on("error", (error) => this.failPending(error));
  }

  static connect(url, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { handshakeTimeout: timeoutMs });
      socket.once("open", () => resolve(new CdpClient(socket)));
      socket.once("error", reject);
    });
  }

  onMessage(raw) {
    let message;
    try { message = JSON.parse(String(raw)); } catch (_) { return; }
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || "Browser command failed"));
      else pending.resolve(message.result || {});
      return;
    }
    for (const listener of this.listeners.get(message.method) || []) {
      try { listener(message.params || {}); } catch (_) {}
    }
  }

  send(method, params = {}, timeoutMs = 20_000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Browser command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) || [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
    return () => this.listeners.set(method, (this.listeners.get(method) || []).filter((item) => item !== listener));
  }

  waitFor(method, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      let off;
      const timer = setTimeout(() => {
        off?.();
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      off = this.on(method, (params) => {
        clearTimeout(timer);
        off();
        resolve(params);
      });
    });
  }

  failPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    try { this.socket.close(); } catch (_) {}
  }
}

function selectorsForService(service) {
  return RENDER_SERVICES[service]?.contentSelectors || ["main", "article", "body"];
}

function commentSelectorsForService(service) {
  return RENDER_SERVICES[service]?.commentSelectors || [
    "[itemprop='comment']", "[data-testid*='comment' i]", ".topic-post", ".comment-item", ".comment", ".reply", ".answer",
  ];
}

function looksLikeAuthentication(payload, service) {
  const url = String(payload?.url || "");
  const text = String(payload?.text || "").replace(/\s+/g, " ").slice(0, 4_000);
  if (/\/(?:login|signin|passport)(?:[/?#]|$)/i.test(url)) return true;
  const configured = RENDER_SERVICES[service]?.authPattern;
  const phrases = configured ? new RegExp(configured, "i") : service === "feishu" ? /扫码登录|登录飞书|sign in to (?:lark|feishu)/i
    : service === "tencent" ? /登录腾讯文档|微信扫码登录|qq扫码登录|sign in.*tencent docs/i
      : service === "wps" ? /登录.*wps|扫码登录|sign in.*wps/i
        : /verify you are human|security verification|captcha|access denied/i;
  return text.length < 2_000 && phrases.test(text);
}

function looksLikeBlockedPage(payload) {
  const title = String(payload?.title || "");
  const text = String(payload?.text || "").replace(/\s+/g, " ").slice(0, 4_000);
  return text.length < 2_000 && /(?:403 forbidden|http error 403|access denied|request blocked|temporarily unavailable|页面访问受限|访问被拒绝)/i.test(`${title} ${text}`);
}

function renderedPayloadExpression(service) {
  const config = JSON.stringify({
    selectors: selectorsForService(service),
    commentSelectors: commentSelectorsForService(service),
    removeSelectors: RENDER_SERVICES[service]?.removeSelectors || ["script", "style", "noscript", "template"],
  });
  return `(() => {
    const config = ${config};
    let root = document.body;
    for (const selector of config.selectors) {
      const candidate = document.querySelector(selector);
      if (candidate && (candidate.innerText || '').trim().length > 60) { root = candidate; break; }
    }
    const container = document.createElement('main');
    const content = root ? root.cloneNode(true) : document.body.cloneNode(true);
    for (const selector of config.removeSelectors) {
      try { for (const node of content.querySelectorAll(selector)) node.remove(); } catch (_) {}
    }
    container.appendChild(content);
    let comments = [];
    for (const selector of config.commentSelectors) {
      try {
        const candidates = [...document.querySelectorAll(selector)].filter((node) => (node.innerText || '').trim().length > 1);
        if (candidates.length) { comments = candidates; break; }
      } catch (_) {}
    }
    const rootIncludesComments = comments.some((node) => root === node || root.contains(node));
    if (comments.length && !rootIncludesComments) {
      const section = document.createElement('section');
      const heading = document.createElement('h2');
      heading.textContent = 'Comments (' + comments.length + ')';
      section.appendChild(heading);
      for (const comment of comments.slice(0, 300)) section.appendChild(comment.cloneNode(true));
      container.appendChild(section);
    }
    const title = (document.querySelector('meta[property="og:title"]') || {}).content || document.title || location.hostname;
    const author = (document.querySelector('meta[name="author"]') || {}).content || '';
    const description = (document.querySelector('meta[property="og:description"]') || document.querySelector('meta[name="description"]') || {}).content || '';
    return { title, author, description, url: location.href, html: container.innerHTML, text: container.innerText, commentCount: comments.length };
  })()`;
}

async function runtimeValue(client, expression, awaitPromise = false) {
  const result = await client.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise }, 30_000);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Page script failed");
  return result.result?.value;
}

async function waitForStablePage(client, service, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  let stable = 0;
  let previous = -1;
  while (Date.now() < deadline) {
    if (COMMUNITY_SERVICES[service] || service === "community-generic") {
      await runtimeValue(client, "window.scrollTo(0, Math.min(document.body.scrollHeight, window.scrollY + window.innerHeight * 1.5)); true");
    }
    const length = Number(await runtimeValue(client, "document.body ? document.body.innerText.length : 0")) || 0;
    stable = length === previous && length > 60 ? stable + 1 : 0;
    previous = length;
    if (stable >= 2) return;
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
}

class WebSessionManager {
  constructor(rootPath) {
    this.rootPath = rootPath;
    this.active = new Map();
    this.locks = new Map();
  }

  profilePath(service) {
    const directory = path.join(this.rootPath, service);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    return directory;
  }

  hasSessionData(service) {
    const directory = path.join(this.rootPath, service);
    if (!fs.existsSync(directory)) return false;
    return fs.readdirSync(directory).some((name) => !name.startsWith("."));
  }

  async start(service, { browserExecutable = "", headless = true, initialUrl = "about:blank" } = {}) {
    const existing = this.active.get(service);
    if (existing && existing.child.exitCode === null) return { ...existing, owned: false };
    const executable = findBrowserExecutable(browserExecutable);
    const port = await freeLocalPort();
    const args = [
      `--user-data-dir=${this.profilePath(service)}`,
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      "--remote-allow-origins=*",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-component-update",
    ];
    if (headless) args.push("--headless=new", "--disable-gpu", "--hide-scrollbars", initialUrl);
    else args.push(`--app=${initialUrl}`);
    const child = childProcess.spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"] });
    let startupError = "";
    child.stderr?.on("data", (chunk) => { startupError = `${startupError}${chunk}`.slice(-4_000); });
    const version = await waitForDebugger(port, child).catch((error) => {
      try { child.kill("SIGTERM"); } catch (_) {}
      throw new Error(`${error.message}${startupError ? `: ${startupError.trim().split("\n").at(-1)}` : ""}`);
    });
    const entry = { child, port, browserWebSocketDebuggerUrl: version.webSocketDebuggerUrl, headless };
    this.active.set(service, entry);
    child.once("exit", () => {
      if (this.active.get(service)?.child === child) this.active.delete(service);
    });
    return { ...entry, owned: true };
  }

  async openLogin(service, options = {}) {
    const config = RENDER_SERVICES[service];
    if (!config) throw new Error(`Unsupported browser service: ${service}`);
    const entry = await this.start(service, { ...options, headless: false, initialUrl: config.loginUrl });
    return { service, name: config.name, profilePath: this.profilePath(service), alreadyOpen: !entry.owned };
  }

  async createPage(entry) {
    const target = await httpJson(`http://127.0.0.1:${entry.port}/json/new?${encodeURIComponent("about:blank")}`, "PUT");
    return CdpClient.connect(target.webSocketDebuggerUrl);
  }

  async extract(url, service, options = {}) {
    const previous = this.locks.get(service) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.locks.set(service, tail);
    await previous;
    try { return await this.extractUnlocked(url, service, options); }
    finally {
      release();
      if (this.locks.get(service) === tail) this.locks.delete(service);
    }
  }

  async extractUnlocked(url, service, options = {}) {
    await validateResolvedHost(url);
    const entry = await this.start(service, { browserExecutable: options.browserExecutable, headless: true });
    const client = await this.createPage(entry);
    const validatedHosts = new Map();
    const validateRequest = async (requestUrl) => {
      if (/^(?:about|blob|data):/i.test(requestUrl)) return true;
      let hostname;
      try { hostname = new URL(requestUrl).hostname; } catch (_) { return false; }
      if (!validatedHosts.has(hostname)) validatedHosts.set(hostname, validateResolvedHost(requestUrl).then(() => true, () => false));
      return validatedHosts.get(hostname);
    };
    const offFetch = client.on("Fetch.requestPaused", (event) => {
      void validateRequest(event.request?.url || "").then((allowed) => client.send(allowed ? "Fetch.continueRequest" : "Fetch.failRequest", allowed
        ? { requestId: event.requestId }
        : { requestId: event.requestId, errorReason: "BlockedByClient" }, 10_000).catch(() => undefined));
    });
    try {
      await client.send("Page.enable");
      await client.send("Runtime.enable");
      await client.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
      const loaded = client.waitFor("Page.loadEventFired", 30_000).catch(() => undefined);
      await client.send("Page.navigate", { url }, 30_000);
      await loaded;
      await waitForStablePage(client, service, options.timeoutMs || 25_000);
      const payload = await runtimeValue(client, renderedPayloadExpression(service));
      await validateResolvedHost(payload.url);
      if (looksLikeBlockedPage(payload)) {
        const error = new Error(`${RENDER_SERVICES[service]?.name || service} blocked automated page access`);
        error.code = "PAGE_ACCESS_BLOCKED";
        throw error;
      }
      if (looksLikeAuthentication(payload, service)) {
        const error = new Error(`${RENDER_SERVICES[service]?.name || service} login or browser verification is required; open its isolated session in plugin settings first`);
        error.code = "DOCUMENT_LOGIN_REQUIRED";
        throw error;
      }
      return payload;
    } finally {
      offFetch();
      try { await client.send("Page.close", {}, 2_000); } catch (_) {}
      client.close();
      if (entry.owned) await this.close(service);
    }
  }

  async close(service) {
    const entry = this.active.get(service);
    if (!entry) return;
    this.active.delete(service);
    try {
      const client = await CdpClient.connect(entry.browserWebSocketDebuggerUrl, 2_000);
      await client.send("Browser.close", {}, 3_000).catch(() => undefined);
      client.close();
    } catch (_) {
      try { entry.child.kill("SIGTERM"); } catch (_) {}
    }
    if (entry.child.exitCode === null) {
      await Promise.race([
        new Promise((resolve) => entry.child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 3_000)),
      ]);
    }
    if (entry.child.exitCode === null) {
      try { entry.child.kill("SIGTERM"); } catch (_) {}
    }
  }

  async closeAll() {
    await Promise.all([...this.active.keys()].map((service) => this.close(service)));
  }
}

module.exports = {
  CdpClient,
  KNOWN_BROWSER_PATHS,
  WebSessionManager,
  commentSelectorsForService,
  findBrowserExecutable,
  looksLikeBlockedPage,
  looksLikeAuthentication,
  renderedPayloadExpression,
  selectorsForService,
};
