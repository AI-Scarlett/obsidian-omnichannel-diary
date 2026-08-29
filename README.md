# Omnichannel Diary

Omnichannel Diary saves messages, web pages, and attachments from chat platforms into a local Obsidian Vault. It supports WeChat, Feishu/Lark, DingTalk, WeCom, QQ, Slack, Telegram, Discord, and WhatsApp.

Version 0.3.x is an independent implementation. It does not contain source code from another Obsidian diary plugin and it has no AI provider, prompt, model, semantic routing, telemetry, account service, or hosted relay.

## What it saves

- Plain messages are appended to `Omnichannel Diary/Daily/YYYY-MM-DD.md`.
- HTTP(S) links can be converted to readable Markdown notes under `Omnichannel Diary/Clippings`.
- Chat attachments and web images are downloaded into `Omnichannel Diary/Attachments`.
- Every entry identifies the channel, conversation, message ID, and any download failure.
- If page extraction or an image download fails, the original URL remains in the daily note.

All folders and capture rules are configurable.

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

WhatsApp does not require a sibling worker file or a system Node installation. Its transport is bundled into the installed `main.js` and runs inside the Obsidian plugin process.

## Configure

Open **Settings → Omnichannel Diary**.

1. In **Channels**, expand a card.
2. Use QR authorization where the official platform supports it, or enter the official Bot credentials.
3. Enable the channel and use **Test reconnect**.
4. In **Capture rules**, choose folders, link clipping, image downloads, group behavior, and file-size limits.

The **Storage & privacy** page explains every local and network data boundary and can clear individual channel credentials.

## Privacy and network behavior

- Message bodies, extracted pages, and successful downloads are written only to the current Vault.
- Channel credentials are stored in the plugin's `data.json`. WhatsApp linked-device credentials are stored in `.channel-data/whatsapp-auth`. These local values are not additionally encrypted.
- Enabling a channel connects directly to that platform's official API and CDN domains.
- Web clipping connects to the submitted page and its image hosts.
- Localhost, link-local, private IP ranges, and redirects to those addresses are blocked.
- There is no telemetry, advertising, remote configuration, automatic publishing, self-update mechanism, or runtime package installation.

See [Privacy and network access](docs/privacy.md) for the detailed list.

## Build and test

Requirements: Node.js 20 or later.

```bash
npm install
npm run verify
```

The production build is generated from `src/main.js`. Verification checks the independent unit tests and confirms that the runtime needs only the official Obsidian release assets.

## Release for the Obsidian community directory

1. Keep `manifest.json`, `package.json`, and `versions.json` on the same version.
2. Run `npm ci && npm run verify`.
3. Create a GitHub release whose tag is the exact version, for example `1.0.0` (no `v` prefix).
4. Attach `main.js`, `manifest.json`, and `styles.css` to the release.
5. Submit the repository through [Obsidian's community plugin submission page](https://community.obsidian.md/).

The repository must remain public and its source must correspond to the release bundle.

## Independent implementation

The 0.3.x codebase was designed from product requirements and public platform/API documentation. Its source tree, tests, UI, build, documentation, and generated bundle were written independently. See [Clean-room record](docs/clean-room.md).

## License

Omnichannel Diary is licensed under AGPL-3.0-only. Bundled third-party components retain their own licenses; see [NOTICE.md](NOTICE.md).
