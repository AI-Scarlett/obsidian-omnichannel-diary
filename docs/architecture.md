# Architecture

The plugin has four product layers:

1. A channel adapter converts a platform event into a small capture envelope.
2. A deterministic router handles `/help`, `/status`, and `/clip`; all other content goes directly to capture.
3. The diary service de-duplicates message IDs, saves chat attachments, routes recognized code-platform URLs through the user's extract/bookmark/both rule, and invokes adapter-based web clipping for remaining HTTP(S) links.
4. The Vault writer serializes appends and creates folders, Markdown files, and binary assets through the Obsidian Vault API.

The web clipping layer routes known content before generic Readability extraction:

- X posts/articles and WeChat articles use dedicated source-aware adapters;
- Xiaohongshu/REDnote notes parse the server-supplied initial-state JSON without executing it, select the full-size image variant for each carousel item, and retain registered rendering as a fallback;
- Reddit prefers the official JSON post/comment listing and falls back to an isolated browser session when public access is challenged;
- Hacker News, GitHub issues/pull requests, Stack Exchange, DEV/Forem, Discourse, and V2EX use structured public post/comment adapters with rendered and generic HTML fallbacks;
- direct PDFs use local text extraction and retain the original binary;
- Feishu/Lark, Tencent Docs, WPS/KDocs, and registered JavaScript-heavy technical communities use a Chromium-compatible browser with a separate Vault-owned profile;
- the community registry declares hosts, detail-page paths, content roots, comment roots, verification rules, and the preferred structured adapter without changing the router;
- unregistered forum engines are detected from generator metadata, discussion-shaped URLs, and common comment markup, then use a generic rendered conversation adapter;
- other HTML pages use Readability and the existing local-image pipeline.

There is no model invocation or semantic decision layer.

The code-platform registry is separate from community extraction. It describes stable host families and URL shapes, classifies repository/resource metadata locally, and supports user-supplied self-hosted domains. Bookmark notes are idempotent by normalized URL and grouped by platform in a dedicated folder.

## Runtime packaging

`scripts/build.mjs` bundles `src/main.js` and all production dependencies into `main.js`. Obsidian is external because it provides the runtime API.

The same bundle has two entries:

- Normal Obsidian load exports the plugin class.
- The WhatsApp transport is bundled into the plugin entry and is forked from the exact bundle path already loaded by Obsidian desktop.

This keeps the three-file Obsidian release format without relying on Electron's disabled run-as-node mode or unavailable V8 workers. The runtime never downloads or extracts an update, and it never writes the plugin bundle or manifest; plugin updates remain exclusively under Obsidian's normal community-plugin release flow. HTTP content encoding is handled only by explicit `gzip`, `deflate`, Brotli, or Zstandard stream decoders and is unrelated to archive extraction.

## Failure behavior

- A channel connection failure changes only that channel's status.
- A failed attachment is written as a warning in the daily note.
- A failed web extraction leaves the original URL in the daily entry.
- A failed code-platform bookmark write leaves the original URL in the daily entry; in combined mode it does not hide an independent extraction result.
- A failed web image remains a remote Markdown image and is counted in the clipping warning.
- A private document or challenged community page without a valid isolated session fails explicitly; the challenge/login page is never reported as extracted content.
- A 403, access-denied page, or rendered body shorter than the acceptance threshold is not reported as a successful clipping; the normal HTML fallback is tried before the original URL is retained as a failure.
- A failed PDF original-file write is counted separately from image failures, while the source URL remains in the daily entry.
- Message IDs are bounded to the latest 500 entries for local de-duplication.
