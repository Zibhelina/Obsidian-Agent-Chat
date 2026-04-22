# Obsidian Agents

A high-quality chat interface for Hermes agents inside Obsidian.

## Features

- **Session Management** — Create, organize, and switch between chat sessions using folders.
- **Rich Media Support** — Paste images, files, and PDFs directly into the composer.
- **Thinking Traces & Metrics** — View agent reasoning, time taken, tokens used, and model info.
- **Hermes CLI Integration** — Run Hermes commands with `/` autocomplete and permission widgets.
- **Dynamic Layouts** — Position images and applets on the left, right, above, or below text.
- **Vault Mentions** — Use `@` to mention files and folders from your vault.
- **Minimal Settings** — Configure agent name, model, and effort level. Inherits Hermes CLI settings by default.

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
| Model         | The AI model Hermes uses                         |
| Effort level  | Low / Medium / High reasoning effort             |

All other configuration (API keys, providers, tools) is inherited from your Hermes CLI setup.

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
    vault.ts         — Vault file search & mention resolution
    layout.ts        — Layout block parsing & CSS grid helpers
  features/
    mentions.ts      — @mention parsing and context injection
    attachments.ts   — Clipboard/drag-drop file handling
    commands.ts      — Hermes CLI command autocomplete
    applets.ts       — Dynamic applet registry (code blocks, charts)
  ui/
    ChatView.ts      — Main Obsidian ItemView
    components/      — Sidebar, Composer, MessageList, MessageBubble,
                       ThinkingTrace, StatusBar, PermissionWidget,
                       LayoutEngine, MentionPopover
```

## Roadmap

- [ ] Real Hermes gateway streaming integration
- [ ] Markdown rendering via Obsidian's `MarkdownRenderer`
- [ ] Additional built-in applets (tables, diagrams, etc.)
- [ ] Export sessions to markdown
- [ ] Search across chat history

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
