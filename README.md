# Omnichannel Diary

**English** | [简体中文](README.zh-CN.md)

Omnichannel Diary saves messages, web pages, and attachments from chat platforms into a local Obsidian Vault. It supports WeChat, Feishu/Lark, DingTalk, WeCom, QQ, Slack, Telegram, Discord, and WhatsApp.

Version 0.4.x is an independent implementation. It does not contain source code from another Obsidian diary plugin and it has no AI provider, prompt, model, semantic routing, telemetry, account service, or hosted relay.

## What it saves

- Plain messages are appended to `Omnichannel Diary/Daily/YYYY-MM-DD.md`.
- HTTP(S) links can be converted to readable Markdown notes under `Omnichannel Diary/Clippings`.
- Code-platform links have an independent rule: extract the page, file only a categorized bookmark under `Omnichannel Diary/Code Links/<Platform>`, or do both. Bookmark-only mode never opens the target page.
- The built-in registry covers GitHub, GitLab, Bitbucket, Azure DevOps, Codeberg, SourceHut, SourceForge, Launchpad, GNU Savannah, Hugging Face Hub, GitFlic, Google Git, Gitee, GitCode, JiHu GitLab, CODING, AtomGit, and GitLink. Custom self-hosted GitLab, Gitea, Forgejo, or internal hosts can be added in settings.
- X posts/articles and WeChat articles retain their dedicated extractors. Reddit posts include nested public comments when its public endpoint is available; an isolated signed-in browser session handles access challenges.
- Technical-community detail pages use an extensible registry rather than hard-coded routing. Hacker News, GitHub issues/pull requests, Stack Exchange, DEV/Forem, Discourse forums, and V2EX have structured post/comment adapters with browser fallback.
- Dynamic community pages cover Product Hunt, GitHub Discussions, Medium, Hashnode, Substack, Lobsters, Indie Hackers, Hugging Face, Kaggle, 掘金, CSDN, 博客园, SegmentFault, 开源中国, 知乎, 少数派, InfoQ, 腾讯云/阿里云开发者社区, 51CTO, Gitee, and GitCode. A generic forum detector also preserves visible comments from unlisted Discourse/Forem/Flarum/NodeBB-style pages.
- Public and private Feishu/Lark, Tencent Docs, and WPS/KDocs pages can be rendered with an isolated local browser profile. The plugin never imports cookies from the user's normal browser profile.
- Direct online PDFs are extracted page by page and the original PDF is stored beside the clipping.
- Community receipts report the number of captured comments in the same bilingual reply format used by every chat channel.
- Chat attachments and web images are downloaded into `Omnichannel Diary/Attachments`.
- Every entry identifies the channel, conversation, message ID, and any download failure.
- If page extraction or an image download fails, the original URL remains in the daily note.
- WeChat and WhatsApp use the same deterministic receipt text. Receipts are retried and kept pending locally until the channel confirms that they were sent.
- WeChat messages are marked processed and its polling cursor is advanced only after the Vault write succeeds.
- WeChat replies include the complete iLink Bot envelope (`client_id`, bot message type, finished state, and the inbound `context_token`) required for mobile delivery.

All folders and capture rules are configurable.

See [Supported clipping sources](docs/supported-sources.md) for the extraction method and limitations of each source family.

## Channel support

| Channel | Connection | Receive transport | Attachments |
| --- | --- | --- | --- |
| WeChat | Official iLink/ClawBot QR authorization | HTTPS long polling | AES-decrypted image, file, video, and voice media |
| Feishu / Lark | Official device registration or App ID/Secret | Official WebSocket SDK | Message resources downloaded through the official API |
| DingTalk | Client ID/Secret | Official Stream SDK | Text plus direct download resources supplied by the event |
| WeCom | Bot ID/Secret | Official bot WebSocket SDK | SDK download and AES decryption |
| QQ | App ID/Secret | Official QQ Bot Gateway SDK | Event attachment URLs |
| Slack | Socket Mode app token and bot token | Socket Mode WebSocket | Authenticated private file URLs |
| Telegram | BotFather token | Bot API long polling | Photo, document, audio, voice, video, and animation |
| Discord | Bot token | Gateway v10 WebSocket | Message attachment URLs |
| WhatsApp | Linked-device QR | Bundled Baileys Node transport | Image, document, audio, video, and sticker |

Platform access is subject to each platform's account eligibility and developer settings. Slack, Telegram, and Discord do not provide QR authorization for their official Bot APIs; their official developer tokens are required.

## Install manually

Copy exactly these three release assets to:

```text
<Vault>/.obsidian/plugins/omnichannel-diary/
```

Required assets:

```text
main.js
manifest.json
styles.css
```

Then reload Obsidian, open **Settings → Community plugins**, and enable **Omnichannel Diary**.

WhatsApp requires an installed Node.js 20.18 or later runtime. Its transport remains bundled in `main.js`, but runs as an isolated Node process so protocol failures cannot crash the Obsidian renderer. The plugin never downloads a runtime or executes a shell command; it launches only an allowlisted `node` / `node.exe` path with fixed arguments.

## Configure

Open **Settings → Omnichannel Diary**.

1. In **Channels**, expand a card.
2. Use QR authorization where the official platform supports it, or enter the official Bot credentials.
3. Enable the channel and use **Test reconnect**.
4. In **Capture rules**, choose folders, code-platform link handling, optional self-hosted code-platform domains, link clipping, dynamic-page rendering, image downloads, group behavior, and file-size limits.
5. For a private Feishu, Tencent Docs, or WPS link, open its isolated sign-in window in **Capture rules → Private cloud-document sessions**, complete sign-in, and close that window. Community sites that present a login or human check have separate opt-in verification windows.

The **Storage & privacy** page explains every local and network data boundary and can clear individual channel credentials.

## Privacy and network behavior

- Message bodies, extracted pages, and successful downloads are written only to the current Vault.
- Channel credentials are stored in the plugin's `data.json`. WhatsApp linked-device credentials and isolated document/community browser profiles are stored below `.channel-data`. These local values are not additionally encrypted.
- Enabling a channel connects directly to that platform's official API and CDN domains.
- Web clipping connects to the submitted page, its image/resource hosts, public community APIs selected by the registry, and any selected cloud-document/community site.
- Code-platform bookmark-only mode parses the URL and writes a local categorized note without requesting that URL. Extract and combined modes use the normal clipping network path.
- Dynamic cloud documents and challenged community pages use an installed Chrome, Edge, Brave, or Chromium executable with a Vault-specific profile. No browser is downloaded or installed by the plugin.
- Direct filesystem access is limited to the plugin's `.channel-data` runtime state and checks for allowlisted Node/browser executable paths. External processes are started with fixed argument arrays and without a shell.
- The isolated WhatsApp process runs the bundle that Obsidian already loaded; the plugin does not target, replace, unpack, or write its own release files. HTTP `gzip` and `deflate` responses use explicit stream decoders and are never treated as plugin archives.
- Localhost, link-local, private IP ranges, and redirects to those addresses are blocked.
- There is no telemetry, advertising, remote configuration, automatic publishing, self-update mechanism, or runtime package installation.

See [Privacy and network access](docs/privacy.md) for the detailed list.

## Build and test

Requirements: Node.js 20.18 or later.

```bash
npm install
npm run verify
```

The production build is generated from `src/main.js`. Verification checks the independent unit tests and confirms that the runtime needs only the official Obsidian release assets.

## Release for the Obsidian community directory

1. Keep `manifest.json`, `package.json`, and `versions.json` on the same version.
2. Run `npm ci && npm run verify`.
3. Create a GitHub release whose tag is the exact version, for example `1.0.0` (no `v` prefix).
4. Generate GitHub build-provenance attestations for `main.js`, `manifest.json`, and `styles.css`.
5. Attach `main.js`, `manifest.json`, and `styles.css` to the release.
6. Submit the repository through [Obsidian's community plugin submission page](https://community.obsidian.md/).

The repository must remain public and its source must correspond to the release bundle.

## Independent implementation

The 0.4.x codebase was designed from product requirements and public platform/API documentation. Its source tree, tests, UI, build, documentation, and generated bundle were written independently. See [Clean-room record](docs/clean-room.md).

## License

Omnichannel Diary is licensed under AGPL-3.0-only. Bundled third-party components retain their own licenses; see [NOTICE.md](NOTICE.md).
