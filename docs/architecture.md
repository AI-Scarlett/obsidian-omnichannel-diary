# Architecture

The plugin has four product layers:

1. A channel adapter converts a platform event into a small capture envelope.
2. A deterministic router handles `/help`, `/status`, and `/clip`; all other content goes directly to capture.
3. The diary service de-duplicates message IDs, saves chat attachments, and invokes web clipping for HTTP(S) links.
4. The Vault writer serializes appends and creates folders, Markdown files, and binary assets through the Obsidian Vault API.

There is no model invocation or semantic decision layer.

## Runtime packaging

`scripts/build.mjs` bundles `src/main.js` and all production dependencies into `main.js`. Obsidian is external because it provides the runtime API.

The same bundle has two entries:

- Normal Obsidian load exports the plugin class.
- The WhatsApp transport is bundled into the plugin entry and uses the Node APIs exposed by Obsidian desktop.

This keeps the three-file Obsidian release format without relying on Electron's disabled run-as-node mode or unavailable V8 workers.

## Failure behavior

- A channel connection failure changes only that channel's status.
- A failed attachment is written as a warning in the daily note.
- A failed web extraction leaves the original URL in the daily entry.
- A failed web image remains a remote Markdown image and is counted in the clipping warning.
- Message IDs are bounded to the latest 500 entries for local de-duplication.
