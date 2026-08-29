# Privacy and network access

## Local data

The plugin writes:

- daily Markdown notes;
- extracted web-page Markdown notes;
- downloaded chat attachments and page images;
- plugin settings and channel credentials in `data.json`;
- WhatsApp linked-device state under `.channel-data/whatsapp-auth`.

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
- Web clipping: the supplied page URL, redirect targets, and image URLs found in its readable content.

The web clipper validates every HTTP(S) redirect and DNS result. It rejects localhost, link-local ranges, private IPv4 ranges, private IPv6 ranges, and non-HTTP protocols.

## Not performed

The plugin has no telemetry, analytics, crash upload, hosted relay, AI provider, automatic publishing, advertising, remote feature flag, runtime dependency installer, or self-update code.
