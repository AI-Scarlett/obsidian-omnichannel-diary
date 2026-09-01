# Omnichannel Diary

[English](README.md) | **简体中文**

Omnichannel Diary 将聊天平台中的消息、网页和附件保存到本地 Obsidian Vault。目前支持微信、飞书/Lark、钉钉、企业微信、QQ、Slack、Telegram、Discord 和 WhatsApp。

0.4.x 版本是独立实现，不包含其他 Obsidian 日记插件的源代码，也不包含 AI 服务商、提示词、模型、语义路由、遥测、账户服务或托管中继。

## 可以保存什么

- 普通消息会追加到 `Omnichannel Diary/Daily/YYYY-MM-DD.md`。
- HTTP(S) 链接可转换为可读的 Markdown 笔记，保存到 `Omnichannel Diary/Clippings`。
- 代码平台地址使用独立规则：提取网页、仅将地址分类收藏到 `Omnichannel Diary/Code Links/<平台>`，或者两者都做。“只分类收藏”模式不会访问目标网页。
- 内置识别 GitHub、GitLab、Bitbucket、Azure DevOps、Codeberg、SourceHut、SourceForge、Launchpad、GNU Savannah、Hugging Face Hub、GitFlic、Google Git、Gitee、GitCode、极狐 GitLab、CODING、AtomGit 和 GitLink。也可以在设置中添加自建 GitLab、Gitea、Forgejo 或内部代码平台域名。
- X 帖子/文章与微信公众号文章使用专用提取器。小红书/REDnote 笔记会安全解析页面中不执行的初始状态数据，保存正文和全部高清轮播图片。Reddit 公开接口可用时会保存帖子及嵌套评论；遇到访问限制时可使用隔离的登录浏览器会话。
- 技术社区详情页由可扩展注册表处理，不使用写死的单站路由。Hacker News、GitHub Issue/PR、Stack Exchange、DEV/Forem、Discourse 论坛和 V2EX 有结构化的帖子/评论适配器，并提供浏览器兜底。
- 动态社区页面覆盖 Product Hunt、GitHub Discussions、Medium、Hashnode、Substack、Lobsters、Indie Hackers、Hugging Face、Kaggle、掘金、CSDN、博客园、SegmentFault、开源中国、知乎、少数派、InfoQ、腾讯云/阿里云开发者社区、51CTO、Gitee 和 GitCode。通用论坛检测还会保留未单独列出的 Discourse、Forem、Flarum、NodeBB 等页面中的可见评论。
- 公开或私有的飞书/Lark 文档、腾讯文档和 WPS/KDocs 页面可通过隔离的本地浏览器渲染。插件不会读取用户日常浏览器中的 Cookie。
- 在线 PDF 会逐页提取文字，并将原 PDF 保存在剪藏旁边。
- 技术社区回执会报告已收集的评论数量，并使用所有聊天渠道统一的中英文回复格式。
- 聊天附件和网页图片会下载到 `Omnichannel Diary/Attachments`。
- 每条记录都会标注渠道、会话、消息 ID 和下载失败项。
- 网页正文或图片提取失败时，原始 URL 仍会保留在每日笔记中。
- 微信与 WhatsApp 使用相同的确定性回执文本。回执发送失败时会重试，并保留在本地待发送队列中，直到渠道确认发送成功。
- 只有在 Vault 写入成功后，微信消息才会标记为已处理并推进轮询游标。
- 微信回复包含移动端投递所需的完整 iLink Bot 信封：`client_id`、Bot 消息类型、完成状态和收到的 `context_token`。

所有目录和收集规则都可以配置。

各类来源的提取方式和限制请参阅[支持的剪藏来源](docs/supported-sources.md)。

## 渠道支持

| 渠道 | 连接方式 | 接收通道 | 附件 |
| --- | --- | --- | --- |
| 微信 | 官方 iLink/ClawBot 扫码授权 | HTTPS 长轮询 | AES 解密图片、文件、视频和语音 |
| 飞书 / Lark | 官方设备注册或 App ID/Secret | 官方 WebSocket SDK | 通过官方 API 下载消息资源 |
| 钉钉 | Client ID/Secret | 官方 Stream SDK | 文字及事件提供的直接下载资源 |
| 企业微信 | Bot ID/Secret | 官方机器人 WebSocket SDK | SDK 下载和 AES 解密 |
| QQ | App ID/Secret | 官方 QQ Bot Gateway SDK | 事件附件 URL |
| Slack | Socket Mode App Token 和 Bot Token | Socket Mode WebSocket | 需要鉴权的私有文件 URL |
| Telegram | BotFather Token | Bot API 长轮询 | 图片、文档、音频、语音、视频和动画 |
| Discord | Bot Token | Gateway v10 WebSocket | 消息附件 URL |
| WhatsApp | 关联设备二维码 | 内置 Baileys Node 传输层 | 图片、文档、音频、视频和贴纸 |

能否接入取决于各平台的账号资格和开发者设置。Slack、Telegram 与 Discord 的官方 Bot API 不提供扫码授权，必须使用官方开发者 Token。

## 手动安装

将下面三个 Release 文件完整复制到：

```text
<Vault>/.obsidian/plugins/omnichannel-diary/
```

必须包含：

```text
main.js
manifest.json
styles.css
```

然后重新加载 Obsidian，打开**设置 → 第三方插件**并启用 **Omnichannel Diary**。

WhatsApp 需要本机安装 Node.js 20.18 或更高版本。传输代码仍内置在 `main.js` 中，但会在独立 Node 进程运行，避免协议故障导致 Obsidian 渲染进程崩溃。插件不会下载运行时或执行 Shell 命令，只会使用固定参数启动白名单中的 `node` / `node.exe`。

## 配置

打开**设置 → Omnichannel Diary**。

1. 在**渠道**页面展开一个渠道卡片。
2. 官方平台支持扫码时使用二维码授权，否则填写平台签发的 Bot 凭据。
3. 启用渠道并点击**测试重连**。
4. 在**收集规则**中配置目录、代码平台处理方式、自建代码平台域名、链接剪藏、动态页面渲染、图片下载、群聊规则和文件大小限制。
5. 私有飞书文档、腾讯文档或 WPS 链接需要在**收集规则 → 私有云文档登录**中打开隔离登录窗口，完成登录后关闭窗口。遇到登录或真人验证的技术社区可使用各自独立且需主动启用的验证窗口。

**存储与隐私**页面会解释所有本地和网络数据边界，并可单独清除各渠道凭据。

## 隐私与网络行为

- 消息正文、提取后的网页和下载成功的文件只会写入当前 Vault。
- 渠道凭据保存在插件 `data.json`。WhatsApp 关联设备凭据以及隔离的文档/社区浏览器 Profile 保存在 `.channel-data` 下，这些本地数据未做额外加密。
- 启用某个渠道后，插件会直接连接该平台的官方 API 和 CDN 域名。
- 网页剪藏会访问用户提交的页面、正文图片/资源域名、注册表选择的公开社区 API，以及用户选择的云文档或技术社区站点。
- 代码平台“只分类收藏”模式只解析 URL 并写入本地分类笔记，不请求该地址；提取和组合模式使用正常网页剪藏网络流程。
- 动态云文档和受访问限制的社区页面使用本机已安装的 Chrome、Edge、Brave 或 Chromium，并为当前 Vault 创建专用 Profile。插件不会下载或安装浏览器。
- 直接文件系统访问仅用于插件 `.channel-data` 运行状态，以及检查白名单中的 Node/浏览器可执行文件路径。外部进程通过固定参数数组启动，不使用 Shell。
- 隔离的 WhatsApp 进程运行的是 Obsidian 已加载的同一插件 Bundle；插件不会定位、替换、解包或写入自身 Release 文件。HTTP `gzip` 和 `deflate` 响应使用明确的流解码器，不会被当成插件压缩包处理。
- localhost、链路本地地址、私有 IP 范围以及指向这些地址的重定向都会被阻止。
- 插件没有遥测、广告、远程配置、自动发布、自更新或运行时安装依赖。

完整列表请参阅[隐私与网络访问说明](docs/privacy.md)。

## 构建与测试

要求 Node.js 20.18 或更高版本。

```bash
npm install
npm run verify
```

生产 Bundle 从 `src/main.js` 生成。验证流程会运行独立单元测试，并确认运行时只需要 Obsidian 官方规定的 Release 文件。

## 发布到 Obsidian 社区插件目录

1. 确保 `manifest.json`、`package.json` 和 `versions.json` 使用相同版本号。
2. 运行 `npm ci && npm run verify`。
3. 创建 GitHub Release，Tag 必须是完整版本号，例如 `1.0.0`，不要添加 `v` 前缀。
4. 为 `main.js`、`manifest.json` 和 `styles.css` 生成 GitHub 构建来源证明（build-provenance attestation）。
5. 将 `main.js`、`manifest.json` 和 `styles.css` 上传为 Release 附件。
6. 通过 [Obsidian 社区插件提交页面](https://community.obsidian.md/)提交仓库。

仓库必须保持公开，且源代码必须与 Release Bundle 对应。

## 独立实现

0.4.x 代码库根据产品需求和公开的平台/API 文档设计。源代码、测试、界面、构建流程、文档和生成 Bundle 均为独立编写。详见[独立实现记录](docs/clean-room.md)。

## 许可证

Omnichannel Diary 使用 AGPL-3.0-only 许可证。内置第三方组件保留各自许可证，详见 [NOTICE.md](NOTICE.md)。
