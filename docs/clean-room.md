# Independent implementation record for 0.4.x

## Boundary

The independent implementation did not reuse earlier plugin source files, generated bundles, tests, UI styles, architecture documents, or implementation-specific names. The previous source entry points and separate WhatsApp worker were removed before the new source tree was written.

Product requirements retained at the boundary are facts and behavior: accept messages from nine named platforms, save text and links to Obsidian, preserve images and other attachments, support QR authorization where the public platform permits it, and ship through the Obsidian community directory.

## Permitted references

Implementation work used public specifications and official SDK/API documentation from Obsidian and the platform providers. Direct SDK dependencies are identified in `NOTICE.md` and keep their original licenses.

## Independent artifacts

The following were newly authored for this project:

- `src/` plugin, core, UI, channel, and worker modules;
- unit tests under `tests/`;
- one-file esbuild configuration and bundle verifier;
- settings interface and stylesheet;
- README, architecture, setup, privacy, and this record.

The public repository history begins with this independent tree, so the distribution is not represented as a fork or continuation of another plugin.

## Behavioral compatibility reviews

Later maintenance may compare public bug reports and acceptance criteria from other projects to identify general failure classes. Those reviews do not import their implementation. The 0.4.x Markdown hardening, link identity, image-budget, message-boundary, bilingual documentation, and settings UI changes were implemented and tested inside this repository's own modular architecture; no external source file, test fixture, test body, or stylesheet was copied into the project.
