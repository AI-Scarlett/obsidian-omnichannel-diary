# Privacy and network access

## Local data

The plugin writes:

- daily Markdown notes;
- extracted web-page Markdown notes;
- categorized code-platform bookmark notes;
- downloaded chat attachments and page images;
- plugin settings and channel credentials in `data.json`;
- WhatsApp linked-device state under `.channel-data/whatsapp-auth`.
- isolated Chromium-compatible profiles for cloud-document and registered community adapters under `.channel-data/document-sessions`. The profile for a sign-in or verification flow is created only when the user opens that flow; headless public extraction profiles contain only browsing state created by this plugin.
- pending remote-search candidate metadata in `data.json` after the user enables Remote search and export. Candidate lists store path, title, time, source, and mtime only. Full note bodies are read only after confirmation, to generate a local packed file.

Credential fields are not additionally encrypted. Anyone with access to the Vault's plugin directory may be able to read them.

## Network destinations

Network access is initiated only for enabled features:

- WeChat: `ilinkai.weixin.qq.com`, an API-directed WeChat host, `liteapp.weixin.qq.com`, and `novac2c.cdn.weixin.qq.com`;
- Feishu/Lark: official `open.feishu.cn` or `open.larksuite.com` API and WebSocket hosts;
- DingTalk: official DingTalk API and Stream hosts;
- WeCom: official `work.weixin.qq.com` API/WebSocket hosts and message download URLs;
- QQ: official QQ Bot API, Gateway, and attachment hosts;
- Slack: `slack.com` API, Socket Mode WebSocket, and authenticated file hosts;
- Telegram: `api.telegram.org`;
- Discord: `discord.com` API and Discord Gateway/CDN;
- WhatsApp: endpoints selected by the bundled linked-device transport;
- Web clipping: the supplied page URL, redirect targets, image/resource URLs found in its readable content (including Xiaohongshu/REDnote's `xhslink.cn` share links and `xhscdn.com` note images), direct PDF files, public endpoints used for Reddit, Hacker News, GitHub, Stack Exchange, DEV/Forem, Discourse, V2EX, and public Google document export, plus rendered cloud-document and registered community pages (including Google Docs/Drive and Microsoft 365/OneDrive).
- Code-platform links: bookmark-only mode performs no request to the supplied code-platform URL; extraction and combined modes use the web-clipping destinations above.

The direct web clipper validates every HTTP(S) redirect and DNS result. The dynamic renderer intercepts browser requests and applies the same public-host validation before continuing them. Both reject localhost, link-local ranges, private IPv4 ranges, private IPv6 ranges, and non-HTTP protocols.

The dynamic renderer launches an already installed Chrome, Edge, Brave, or Chromium executable with a Vault-specific user-data directory. It does not read the user's normal browser profile or cookies, download a browser, install a package, upload session data, or enter credentials. Sign-in and human-verification steps happen only in a window the user explicitly opens.

## Local process boundaries

WhatsApp runs in an isolated Node.js 20.18+ process so a protocol failure cannot crash the Obsidian renderer. Dynamic document extraction may launch an installed Chromium-compatible browser. Both launches use fixed argument arrays with no shell, accept only allowlisted executable names, and never download or install an executable. Direct filesystem writes are scoped to `.channel-data` beneath this plugin's directory; system paths are only checked while locating an allowlisted Node or browser executable.

## Not performed

By default the plugin does not scan Markdown notes outside the capture workflow. Enabling Remote search and export allows the plugin to read Markdown files in the chosen folder so a connected bot can return titles, times, sources, and paths, and later pack confirmed notes on this computer.

The plugin has no telemetry, analytics, crash upload, hosted relay, AI provider, automatic publishing, advertising, remote feature flag, runtime dependency installer, or self-update code.
