# Obsidian Agents

A high-quality chat interface for Hermes agents inside Obsidian.

## Features

- **Session Management** — Create, organize, and switch between chat sessions using folders.
- **Rich Media Support** — Paste images, files, and PDFs directly into the composer.
- **Thinking Traces & Metrics** — View agent reasoning, time taken, tokens used, and model info.
- **Hermes CLI Integration** — Run Hermes commands with `/` autocomplete and permission widgets.
- **Dynamic Layouts** — Position images and applets on the left, right, above, or below text.
- **Vault Mentions** — Use `@` to insert inline file/folder mention chips backed by parseable `@[label](path)` text.
- **Context Bundles** — Mentions and attachments are sent as structured `ctx_n` references with compact metadata instead of ad hoc context walls.
- **Attachment Vault** — Pasted/dropped originals and image derivatives are stored under `agent-vault/runtime/` for debugging and on-demand inspection.
- **Context Hygiene** — Historical images, audio, tool traces, and debug payloads are archived by reference instead of being replayed into every request.
- **Minimal Settings** — Configure agent name and effort level. Active model routing is inherited from Hermes config by default.

## Installation

### From Source

1. Clone or copy this repository into your vault's `.obsidian/plugins/` folder:
   ```bash
   cd /path/to/your/vault/.obsidian/plugins/
   git clone https://github.com/Zibhelina/Obsidian-Agent-Chat.git obsidian-agents
   cd obsidian-agents
   ```

2. Install dependencies and build:
   ```bash
   npm install
   npm run build
   ```

3. Enable **Obsidian Agents** in Obsidian's Community Plugins settings.

### Development

Run the watcher for live rebuilds:
```bash
npm run dev
```

## Usage

Open Obsidian Agents via:
- The **message-circle** ribbon icon
- The Command Palette: `Obsidian Agents: Open Obsidian Agents`

### Keyboard Shortcuts

- `Ctrl/Cmd + Enter` — Send message
- `@` — Mention a vault file or folder
- `/` — Trigger Hermes command autocomplete

### Settings

Obsidian Agents keeps settings minimal:

| Setting       | Description                                      |
|---------------|--------------------------------------------------|
| Agent name    | Display name for the AI agent                    |
| Active Hermes model | Read-only view of the model/provider Hermes is currently routing to |
| Effort level  | Minimal / Low / Medium / High reasoning effort   |

All other configuration (API keys, providers, tools, model routing) is inherited from the local Hermes setup.

## Context and File Handling

Obsidian Agents keeps the visible chat transcript clean while building a separate model-facing request.

- Inline vault mentions are stored as plain text such as `@[README](projects/foo/README.md)` and rendered as compact chips in the composer.
- On send, mentions and attachments are normalized into `ContextItem` records with stable request-local ids such as `ctx_1`.
- The model-facing user message contains readable references like `[ctx_1: README.md]` plus one `<context_bundle>` JSON block.
- Pasted and dropped originals are written to `.obsidian/plugins/obsidian-agents/agent-vault/runtime/attachments/`.
- Image derivatives for model input are written to `.obsidian/plugins/obsidian-agents/agent-vault/runtime/derivatives/`.
- Context bundle debug JSON is written to `.obsidian/plugins/obsidian-agents/agent-vault/runtime/context-bundles/`.
- Historical image/audio attachments are reference-only on later turns. Base64 payloads are not replayed into every request.
- If current-turn binary payloads would push the estimated request over 80% of the configured context window, the request keeps file references and omits the pixels/audio.

## Trace Archival

Full reasoning/tool/debug payloads are archived outside normal session JSON after a turn completes. Stored assistant messages keep compact `traceRef` metadata pointing to `.obsidian/plugins/obsidian-agents/agent-vault/traces/`, and the model receives only compact archived activity pointers for previous turns.

The reasoning drawer can still show where full archived activity lives, but hidden traces and raw tool outputs are not repeatedly carried in active chat context.

## Architecture

```
src/
  plugin.ts          — Main plugin lifecycle, settings tab, session management
  types.ts           — Core TypeScript interfaces
  settings.ts        — Settings load/save helpers
  storage.ts         — Session/folder persistence
  hermes.ts          — Hermes CLI/gateway communication
  tokenizer.ts       — Token estimation utilities
  lib/
    id.ts            — ID generation
    agentVaultRuntime.ts — Runtime artifact path and write helpers
    vault.ts         — Vault file search & mention resolution
    layout.ts        — Layout block parsing & CSS grid helpers
  features/
    mentions.ts      — @mention parsing and inline mention token support
    contextBundle.ts — ContextItem/context bundle construction
    attachments.ts   — Clipboard/drag-drop file handling
    commands.ts      — Hermes CLI command autocomplete
    applets.ts       — Dynamic applet registry (code blocks, charts)
  ui/
    ChatView.ts      — Main Obsidian ItemView
    components/      — Sidebar, Composer, MessageList, MessageBubble,
                       ThinkingTrace, StatusBar, PermissionWidget,
                       LayoutEngine, MentionPopover
```

## Recent Changes

See [CHANGELOG.md](./CHANGELOG.md) for the 2026-05-12 context hygiene, context bundle, inline mention, trace archive, provider routing, and skill updates.

## Background-job callback server

The plugin runs a small local HTTP server so scheduled / background jobs (cron, deferred tasks) run by your Hermes gateway can deliver their results back into the right place — the chat that scheduled the job, a new chat, a vault note, or a toast notification.

- Default bind: `127.0.0.1` on an ephemeral port, token-authed.
- Configure host, port, and token under **Settings → Obsidian Agents → Background-job callback server**.
- The plugin injects the current callback URL, token, and session id into the system prompt on every request — the agent uses that context to tell the gateway where to POST.

### Choosing a delivery channel

The agent picks a channel based on the user's phrasing. Examples:

| User says… | Channel | Target |
|---|---|---|
| "…reply here when it's done." | `chat` | current session |
| "…reply in a new chat." | `new-chat` | — |
| "…save the result to `Daily/Summary.md`." | `note` | vault path |
| "…just ping me." | `notice` | — |
| *(no destination specified)* | `chat` *(default)* | current session |

### Gateway HTTP contract

Whichever scheduler or cron runner your Hermes gateway uses, it should POST to the plugin's callback endpoint when a job fires:

```
POST http://127.0.0.1:<port>/callback
Authorization: Bearer <callback_token>
Content-Type: application/json

{
  "channel": "chat" | "new-chat" | "note" | "notice",
  "sessionId": "<session id>",
  "target": "Daily/Summary.md",
  "payload": {
    "content": "...markdown body...",
    "title": "optional short label",
    "metadata": { "jobId": "...", "firedAt": "..." }
  }
}
```

The plugin responds `200 {ok:true, channel}` on success, `400` for bad input, `401` for bad token, `500` for delivery errors.

### Adding your own channel

Channels are pluggable. Drop a file into `src/callback/channels/` implementing the `DeliveryChannel` interface and register it in `src/callback/channels/index.ts`. The built-in channels (`chat`, `new-chat`, `note`, `notice`) are reference implementations.

## Author

Joao Henrique Costa Araujo

## License

MIT — see [LICENSE](./LICENSE)
