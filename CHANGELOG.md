# Changelog

## 2026-05-12

### Context Hygiene

- Replaced ad hoc mention injection with metadata-first context bundles.
- Added `ContextItem`, `ContextBundle`, and `ContextBundleRef` types for mentions, attachments, originals, derivatives, statuses, and durable debug paths.
- Added context-bundle generation for user sends. Mentions now become readable `[ctx_n: filename]` references in the model-facing message, followed by one `<context_bundle>` JSON block.
- Stopped normal mention handling from inlining file bodies into `<context file="...">...</context>` blocks.
- Saved context bundle JSON files under `.obsidian/plugins/obsidian-agents/agent-vault/runtime/context-bundles/<sessionId>/<messageId>.json`.

### Attachments and Images

- Preserved pasted and dropped attachment metadata: MIME type, byte size, source, and runtime bytes.
- Saved pasted/dropped originals under `.obsidian/plugins/obsidian-agents/agent-vault/runtime/attachments/<sessionId>/<messageId>/originals/`.
- Added JPEG visual derivatives for images under `.obsidian/plugins/obsidian-agents/agent-vault/runtime/derivatives/<sessionId>/<messageId>/`.
- Sent optimized current-turn image derivatives to the model when budget allows.
- Prevented historical image/audio base64 payloads from being replayed on later turns. Old turns now produce compact `<attachment_context_refs>` blocks instead.
- Added an 80% context-window budget guard for current-turn binary payloads. If an image/audio payload would push the request over the threshold, the request keeps references and omits the pixels/audio.
- Stripped persisted `dataUrl` blobs from new stored messages once durable vault files exist.
- Added a legacy migration path that converts previously saved base64 attachment blobs into agent-vault files and compact refs on session load.
- Kept user-facing image previews working by rendering image attachments from vault resource paths when base64 is no longer stored.

### Trace and Session Storage

- Added trace artifact archival under `.obsidian/plugins/obsidian-agents/agent-vault/traces/`.
- Compacted stored assistant metadata by replacing full reasoning/tool/debug payloads with `traceRef` pointers after archival.
- Added archived activity pointers to the system prompt so prior hidden reasoning, tool calls, and context-debug snapshots stay inspectable without remaining in active chat context.
- Updated the reasoning drawer to display archived activity references when full trace payloads were compacted.

### Context Debugger

- Added parsing for OpenAI Responses API-shaped payloads.
- Distinguished current request tool schemas from historical tool calls/tool results.
- Added context-bundle block extraction and labeling.
- Stopped classifying arbitrary messages as summaries based only on keywords.
- Improved token estimate fallback behavior when provider/gateway usage is unavailable.

### Inline Mentions

- Moved selected vault mentions into the CodeMirror composer text instead of rendering them as a fixed chip row above the composer.
- Inserted selected mentions as canonical `@[Display Name](vault/path.md)` text.
- Rendered inline mention markup as CodeMirror live-preview chips when the cursor is outside the token, while preserving raw editable text when editing inside it.
- Updated mention parsing to support escaped labels/paths and multiple inline mentions.
- Updated message rendering to strip inline mention tokens from user bubbles while still showing mention chips separately.

### Model Routing and Provider Picker

- Moved active model display/routing toward Hermes config as the source of truth.
- Stopped sending stale plugin `model` values when Hermes is already routing through its own config.
- Added Claude Code as a separate provider option that writes the Anthropic provider slug expected by Hermes.
- Added Claude Code credential discovery through local credential files/keychain where available.
- Tightened provider availability checks so expired/exhausted credentials are not offered as valid routes.
- Added current runtime metadata to the system prompt: local time, UTC time, timezone, active provider, active model, and base URL when available.

### Skills

- Expanded the applet skill with stronger product-quality and interaction guidance.
- Rewrote the tutor skill around stricter Socratic teaching, first-principles explanations, focused checks, and no direct homework-answering.
- Updated existing skills to point at the current `agent-vault` location.

### Runtime and Ignore Rules

- Added agent-vault runtime helpers for safe filenames, directory creation, binary/text writes, local path lookup, and collision-safe paths.
- Ignored `.obsidian/plugins/obsidian-agents/agent-vault/` in both the vault root `.gitignore` and the plugin `.gitignore` so runtime artifacts do not leak into the public repo.
