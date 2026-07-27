# Obsidian Agents Plugin Architecture

## Overview

Obsidian Agents is an Obsidian chat interface for Hermes. The plugin owns the UI, composer behavior, session display, context debugging, and the gateway request shape. Hermes owns model routing, credentials, provider transport, and tool execution.

The current architecture prioritizes context hygiene:

- user-visible chat history stays clean and readable
- model-facing requests get structured context metadata
- historical binary payloads, tool outputs, reasoning traces, and debug snapshots are archived by reference
- runtime artifacts live under `agent-vault/` and are ignored by git

## Tech Stack

- TypeScript + esbuild
- Obsidian API
- CodeMirror 6 decorations for composer live preview
- CSS variables for Obsidian-native theming
- Hermes local gateway for streaming model responses

## Module Structure

```text
main.ts                          -- Entry point
manifest.json                    -- Plugin manifest
package.json                     -- Dependencies and build scripts
esbuild.config.mjs               -- Build config
tsconfig.json                    -- TypeScript config
styles.css                       -- Obsidian-loaded styles
CHANGELOG.md                     -- Dated implementation notes
src/
  plugin.ts                      -- Main Plugin class, lifecycle, sessions, send flow, settings
  types.ts                       -- Core shared types
  settings.ts                    -- Settings load/save helpers
  storage.ts                     -- Session/folder persistence with trace compaction
  hermes.ts                      -- Hermes gateway request construction and streaming
  contextDebug.ts                -- Request snapshot parsing and token block extraction
  traceArtifacts.ts              -- Reasoning/tool/debug archive writer
  tokenizer.ts                   -- Token estimation utilities
  lib/
    agentVaultRuntime.ts         -- Safe runtime artifact paths and vault writes
    hermesConfig.ts              -- Active Hermes model/config helpers
    hermesProviders.ts           -- Provider/auth/model picker catalog
    id.ts                        -- ID generation
    layout.ts                    -- Layout block parsing and CSS grid helpers
    modelsCache.ts               -- Hermes model cache loader
    vault.ts                     -- Vault search and file helpers
  features/
    attachments.ts               -- Paste/drop/file attachment capture
    contextBundle.ts             -- ContextItem normalization, derivatives, bundle persistence
    mentions.ts                  -- Mention parsing and escaping
    commands.ts                  -- Slash-command autocomplete
    applets.ts                   -- Dynamic applet registry and rendering
  skills/
    *.ts                         -- On-demand slash skills injected per turn
  ui/
    ChatView.ts                  -- Main Obsidian ItemView
    components/
      Composer.ts                -- Input, attachments, skills, send/stop
      LivePreviewEditor.ts       -- CodeMirror editor and inline mention chips
      MentionPopover.ts          -- Vault mention search and insertion
      MessageBubble.ts           -- Message, attachment, mention, trace, debug rendering
      ContextDebugModal.ts       -- Context debugger UI
      ModelPicker.ts             -- Hermes-backed provider/model picker
      ThinkingTrace.ts           -- Reasoning/tool/archive drawer
```

## Core Data Contracts

### Messages

`ChatMessage` keeps the visible transcript and lightweight metadata:

- `content`: raw user-visible message text
- `attachments`: persisted attachment metadata and durable paths
- `contextBundle`: current structured context metadata when useful
- `contextBundleRef`: compact pointer to the saved bundle JSON
- `metadata.traceRef`: compact pointer to archived assistant activity

New messages avoid persisting large base64 blobs once the original attachment has been saved to `agent-vault`. Older sessions are migrated on load when possible.

### Context Items

Every mention or direct attachment can become a `ContextItem`:

- `id`: stable per-request id like `ctx_1`
- `source`: `mention`, `paste`, `drop`, `attachment`, or `screenshot`
- `kind`: `text`, `image`, `pdf`, `audio`, `folder`, etc.
- `status`: `available_not_loaded`, `included_visual_proxy`, `included_audio`, `referenced_not_inlined`, or `failed`
- `original`: durable original file metadata
- `derivatives`: optional model-facing artifacts such as JPEG visual proxies

The model-facing user message contains readable references and one compact bundle:

```text
Compare [ctx_1: README.md] with [ctx_2: screenshot.png].

<context_bundle version="1">
{ ...ContextBundle JSON... }
</context_bundle>
```

## Send Flow

1. `Composer` sends raw editor text plus attachments to `plugin.sendMessage()`.
2. `buildContextBundle()` parses inline mentions, writes attachment originals, creates image derivatives, and saves bundle JSON.
3. The stored `ChatMessage` keeps the raw user text and durable attachment references.
4. The API-only user message gets `[ctx_n: name]` references, the `<context_bundle>`, and current-turn optimized multimodal derivatives when budget allows.
5. `hermes.ts` builds the gateway request:
   - system prompt
   - runtime metadata
   - file/image handling policy
   - archived trace pointers
   - historical messages with attachment refs only
   - latest user message with current-turn image/audio parts only when allowed
6. The gateway streams tokens, reasoning, tool status, usage, and context debug snapshots back into the UI.
7. On save, `storage.ts` archives full reasoning/tool/debug metadata into trace artifacts and stores only `traceRef` pointers in session JSON.

## Context Hygiene Rules

- Preserve user messages verbatim in the visible transcript.
- Preserve visible assistant answers verbatim.
- Do not replay historical image/audio base64 payloads on later turns.
- Do not keep full historical tool outputs or hidden reasoning in active chat context.
- Keep current-turn image/audio parts only when they fit the configured request budget.
- Use compact refs for previous attachments and activity traces.
- Make the model aware that a file/image reference is not the same thing as having inspected the file/image.

## Agent Vault Runtime

Runtime artifacts live under:

```text
.obsidian/plugins/obsidian-agents/agent-vault/
```

Current runtime subpaths:

```text
agent-vault/runtime/attachments/<sessionId>/<messageId>/originals/
agent-vault/runtime/derivatives/<sessionId>/<messageId>/
agent-vault/runtime/context-bundles/<sessionId>/<messageId>.json
agent-vault/traces/<sessionId>/<messageId>.trace.json
```

Both the vault root `.gitignore` and plugin `.gitignore` ignore `agent-vault/` so private runtime artifacts, attachments, traces, and debug payloads do not leak into git.

## Inline Mention System

The composer stores mentions as stable plain text:

```text
@[Display Name](vault/path.md)
```

`MentionPopover` inserts that syntax at the cursor. `LivePreviewEditor` renders it as an inline chip when the cursor is outside the token, and shows raw editable text when the cursor enters the token. `mentions.ts` parses the raw syntax on send, including escaped labels and paths.

This keeps copy/paste, undo/redo, persistence, and debugging sane while making the composer feel natural.

## Attachment Policy

Direct pasted/dropped files are durable-first:

- preserve original bytes when available
- write originals to `agent-vault/runtime/attachments/`
- create JPEG visual proxies for image model input
- include the visual proxy only for the latest turn and only within budget
- represent historical attachments as `<attachment_context_refs>`

Mentioned vault files are metadata-first. Text files are not automatically inlined in the current flow; they are references the model can ask to inspect when relevant.

## Context Debugger

The debugger accepts both chat-completions style `messages` payloads and OpenAI Responses API-style `input` payloads. It distinguishes:

- system/developer/user/assistant content
- context bundles
- attachment refs
- current tool schemas
- historical tool calls and tool results
- summaries and unknown blocks

Tool schemas are labeled separately because they are allowed current-request capability declarations, not historical tool activity.

## Model Routing

Hermes config is the source of truth for active provider/model routing. The plugin settings tab shows the current Hermes route instead of maintaining a separate conflicting model field.

The model picker writes the active provider/model/base URL into Hermes config. Claude Code appears as its own picker provider where credentials are available, while writing the Anthropic provider slug expected by Hermes.

## Skills

Skills are on-demand system prompt modules selected through slash commands. Add your own project-context skills through the manage-skills flow, which keeps your paths and preferences on your own machine.

The applet and tutor skills contain stricter quality/pedagogy rules.
