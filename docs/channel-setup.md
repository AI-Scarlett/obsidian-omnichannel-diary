# Channel setup notes

## QR authorization

- **WeChat** uses the public iLink/ClawBot authorization flow. Availability depends on WeChat's account rollout.
- **Feishu/Lark** can use the SDK's OAuth device registration to create an app, or existing App credentials can be entered.
- **WhatsApp** uses the Linked Devices flow. In WhatsApp, open **Settings → Linked Devices → Link a Device**.

## Developer credentials

- **DingTalk:** create an application with robot Stream capability and copy Client ID/Secret.
- **WeCom:** create an intelligent robot that supports the official long connection and copy Bot ID/Secret.
- **QQ:** create a QQ Open Platform bot and copy App ID/Secret.
- **Slack:** enable Socket Mode, subscribe to message events, and provide an `xapp-` app token plus `xoxb-` bot token. Add file-reading and message-writing scopes if those features are needed.
- **Telegram:** create a bot with `@BotFather` and paste its token.
- **Discord:** create an application/bot, enable Message Content intent, invite the bot to the desired server, and paste the bot token.

These platforms control permissions and rate limits. A green status confirms transport connection; it does not override missing event subscriptions or media scopes in the platform console.
