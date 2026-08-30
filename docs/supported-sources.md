# Supported clipping sources

Omnichannel Diary uses three extraction layers. A structured public adapter is preferred where a platform exposes stable post/comment data. Registered dynamic pages use a Vault-owned Chromium profile. All other pages retain the generic Readability path, with automatic forum/comment detection when common conversation markup is present.

## Code-platform links

Code-hosting URLs are recognized before ordinary clipping. The user chooses one deterministic rule for repository pages and resources such as issues, pull/merge requests, discussions, releases, commits, trees, and files:

- **Extract page content** uses the normal structured/rendered/Readability clipping path.
- **File bookmark only** writes a small Markdown record under `<Code-platform folder>/<Platform>` and does not request the target URL.
- **Extract and file bookmark** performs both operations independently, so a categorized link can still be retained if page extraction fails.

Built-in international platforms: GitHub, GitLab, Bitbucket, Azure DevOps, Codeberg, SourceHut, SourceForge, Launchpad, GNU Savannah, Hugging Face Hub, GitFlic, and Google Git.

Built-in China platforms: Gitee, GitCode, JiHu GitLab, CODING, AtomGit, and GitLink.

Additional self-hosted GitLab, Gitea, Forgejo, and internal code-platform hostnames can be entered in settings. The setting accepts hostnames only and must never contain credentials or tokens.

## Structured sources

| Source | Saved content | Fallback |
| --- | --- | --- |
| X | Post/article text, author, quoted content, media | Generic page extraction |
| WeChat articles | Official-article body, author, account, media | Generic page extraction |
| Reddit | Post, external link/media, nested public comments | Isolated rendered page after an access challenge |
| Hacker News | Story metadata, linked page, nested comments | Registered rendered page |
| GitHub issues and pull requests | Body, issue comments, pull-review comments | Registered rendered page; Discussions always use rendering |
| Stack Overflow / Stack Exchange | Question, answers, accepted answer, post comments | Registered rendered page |
| DEV / Forem | Article and threaded comments | Registered rendered page |
| Discourse forums | Topic and ordered replies, including supported custom-domain `/t/…/<id>` topics | Registered or generic rendered page |
| V2EX | Topic and replies | Registered rendered page when the public endpoint is unavailable |
| Direct PDF | Page text and the original PDF binary | Original link remains in the daily note on failure |

## Registered rendered communities

International: Product Hunt, GitHub Discussions, Medium, Hashnode, Substack, Lobsters, Indie Hackers, Hugging Face Discussions, and Kaggle Discussions.

China: 掘金, CSDN, 博客园, SegmentFault 思否, 开源中国, 知乎, 少数派, InfoQ, 腾讯云开发者社区, 阿里云开发者社区, 51CTO, Gitee issues, and GitCode discussions/issues.

The registry stores matching hosts and detail-page paths separately from extraction logic. Adding a new site does not change the chat router or Vault writer.

## Generic community fallback

Unlisted pages are treated as conversations when the page identifies a common forum engine (Discourse, Forem, Flarum, NodeBB, Question2Answer, Vanilla Forums, or XenForo), uses a discussion-shaped URL, or exposes recognizable comment/reply markup. The clipping keeps the readable main body and currently public comments found in the page.

## Boundaries

- “Supported” means the adapter and fallback are implemented; it does not guarantee that a third-party site will always allow automated access.
- Login walls, paywalls, deleted/private posts, rate limits, region restrictions, CAPTCHAs, and site redesigns can reduce what is available.
- The plugin does not bypass access controls. It uses only content the user's isolated session can legitimately view.
- Dynamic pages can expose only comments loaded by the page during the bounded extraction window. A receipt reports the number actually captured.
- Image-only scanned PDFs do not yet have OCR; text-based PDFs are supported.
