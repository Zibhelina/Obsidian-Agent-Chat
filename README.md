# Obsidian Agents

A high-quality chat interface for [Hermes](https://github.com/) agents inside [Obsidian](https://obsidian.md). Obsidian Agents owns the chat UI, composer, session model, and request shape; Hermes owns model routing, credentials, providers, and tool execution. Together they turn Obsidian into a thoughtful, file-aware agentic workspace.

This README is intentionally long. It is meant to be enough for a new contributor — or a curious user — to fully understand the project by reading it once, from top to bottom.

---

## Table of contents

1. [What it is, in one paragraph](#what-it-is-in-one-paragraph)
2. [Design philosophy](#design-philosophy)
3. [Feature tour](#feature-tour)
4. [From zero to running: full setup tutorial](#from-zero-to-running-full-setup-tutorial)
5. [Installation and development](#installation-and-development)
6. [Settings reference](#settings-reference)
7. [Architecture overview](#architecture-overview)
8. [The send flow, step by step](#the-send-flow-step-by-step)
9. [Context bundles and attachments](#context-bundles-and-attachments)
10. [Trace archival and context hygiene](#trace-archival-and-context-hygiene)
11. [Inline mentions](#inline-mentions)
12. [Skills (slash commands)](#skills-slash-commands)
13. [Background-job callback server](#background-job-callback-server)
14. [Rich layouts and applets](#rich-layouts-and-applets)
15. [Context debugger](#context-debugger)
16. [Storage layout and runtime artifacts](#storage-layout-and-runtime-artifacts)
17. [Module map](#module-map)
18. [Glossary](#glossary)

---

## What it is, in one paragraph

Obsidian Agents is a desktop-only Obsidian plugin that mounts a full chat workbench inside the right sidebar. You type messages, mention vault files with `@`, invoke skills with `/`, paste images or audio, and a streamed reply comes back with optional reasoning traces, tool calls, interactive applets, and rich media layouts. Under the hood it talks to a local [Hermes](https://github.com/) gateway over an OpenAI-compatible HTTP/SSE protocol. The plugin's job is to make that conversation pleasant, file-aware, and **context-hygienic**: it never replays old binary blobs into the model, it archives reasoning traces by reference, and it keeps the user-visible transcript clean while building a structured, debuggable request for the model.

---

## Design philosophy

A few principles run through every module.

- **Separation of concerns with Hermes.** Hermes owns the gateway, credentials, providers, model routing, and tool execution. The plugin owns UI, sessions, composer behavior, attachment handling, and the *shape* of each request. The active model and approval mode live in `~/.hermes/config.yaml` so every Hermes client (CLI, TUI, this plugin, etc.) sees the same routing.
- **Context hygiene over completeness.** Models pay tokens for everything you send. The plugin aggressively prunes anything the model doesn't actually need *right now*: historical base64 images, raw tool outputs, hidden reasoning, debug snapshots, and full text bodies of mentioned files. Past content survives as compact references, not payloads.
- **Two transcripts, not one.** What the user sees and what the model receives are different artifacts. User bubbles render raw text plus chips; the model receives `[ctx_n: filename]` references followed by a single `<context_bundle>` JSON block.
- **Durable artifacts, ephemeral transport.** Originals, derivatives, bundles, and traces are written to disk under `agent-vault/` (gitignored). Storage is the source of truth; in-memory base64 blobs are discarded as soon as a durable file exists.
- **Make the model honest.** Every system prompt teaches the model that a file *reference* is not the same thing as having *inspected* the file. If it needs to read something, it should use tools — and if a payload was omitted for budget reasons, the prompt says so.
- **Composer feels native.** The input is a CodeMirror 6 editor with live-preview markdown, inline mention chips, skill chips, and live attachment thumbnails — but the underlying text is plain, copy-pasteable, undo-friendly Markdown.

---

## Feature tour

- **Session management** — Sessions live in a folder tree, support drag-drop, rename, branch-from-message, and have an unread-dot indicator that lights up when an agent reply lands while you're looking elsewhere.
- **Streaming responses** — Tokens, reasoning ("thinking"), tool calls, layout blocks, and usage metrics stream in over SSE. The reasoning panel ticks a live timer; the user can scroll without being yanked back to the bottom.
- **Reasoning trace drawer** — Per-message collapsible panel with the model's `<thinking>` content interleaved with tool calls in a timeline, resizable to fullscreen.
- **Steering queue** — Messages you type while a stream is in flight buffer up and coalesce into the next turn instead of getting lost or interrupting.
- **Vault mentions** — Type `@` to fuzzy-search files and folders. Selections insert as `@[Display](vault/path.md)` plain text that the composer renders as a chip.
- **Skill chips (`/`-commands)** — On-demand prompt modules: tutor, applet builder, web search, automation/scheduler, audio transcription, plugin self-improve, etc. Up to three active per turn, displayed as chips above the composer.
- **Multimodal attachments** — Paste, drop, or mention images, audio, PDFs, and text files. Images are downscaled to a JPEG visual proxy for the model; originals are kept durably on disk.
- **Inline applets** — The agent can emit `obsidian-agents-applet` (raw HTML/JS) or `obsidian-agents-react` (React 18) fenced blocks that mount as sandboxed, theme-aware iframes inside the message. Used for interactive widgets, charts, 3D scenes, simulators.
- **Rich layout blocks** — JSON-driven `obsidian-agents-hero`, `obsidian-agents-gallery`, `obsidian-agents-carousel`, `obsidian-agents-map`, `obsidian-agents-card-list`, `obsidian-agents-split`, and `obsidian-agents-terms` blocks render polished media-rich replies.
- **Inline term glossary** — `[[Label]]{#slug}` markers in a reply open a slide-in panel with the term's hero image, summary, key facts, and source links (driven by a `obsidian-agents-terms` block).
- **Permission widgets** — Dangerous tool calls render as an inline applet with Accept / Deny / Explain buttons, controlled by the approval mode in Hermes config.
- **Context debugger** — A three-tab modal (Blocks / Raw JSON / Stats) lets you inspect exactly what was sent: each labeled block, token estimates, context-window usage, cost, and compaction status.
- **Cost & token stats** — A header info popover shows session token usage and a price estimate. Unknown models are surfaced so you know when the estimate is partial.
- **Reply / branch / minimap** — Select text in a bubble to "Reply" with a quote; branch a session from any message to fork the conversation; a vertical dot rail on the right minimaps the conversation and zooms under the cursor.
- **Background-job callbacks** — A local token-authed HTTP server lets scheduled/deferred jobs deliver results back into the current chat, a new chat, a vault note, or a toast — without polling.

---

## From zero to running: full setup tutorial

This tutorial walks you all the way from an empty machine to a working Obsidian vault with Hermes-powered chat — the same setup the author runs. Follow the steps in order; each one is small and verifiable.

You will end up with:

- Obsidian installed and a vault created.
- Hermes Agent installed and authenticated against at least one LLM provider.
- The Hermes **gateway** (a local HTTP server) running in the background and surviving reboots.
- This plugin installed inside the vault, built, enabled, and pointed at the gateway.
- A working chat session, with the model picker, attachments, mentions, and skills all functional.

Estimated time: **15–25 minutes** the first time.

### Prerequisites

You need a Linux, macOS, or WSL2 machine. Native Windows is **not** supported by Hermes; install [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install) first. Android via Termux is supported by Hermes but the plugin itself is desktop-only.

Have these ready on your PATH:

| Tool | Why | How to check |
|---|---|---|
| `git` | Clone the plugin repo. | `git --version` |
| `node` ≥ 18 and `npm` | Build the plugin bundle. | `node -v && npm -v` |
| `curl` | Hermes one-line installer. | `curl --version` |
| Obsidian ≥ 1.6 | The host app. | Download at <https://obsidian.md>. |

You also need an account with **at least one** of the LLM providers Hermes supports — the easiest first choice is [OpenRouter](https://openrouter.ai/keys), because one key unlocks 200+ models. [Anthropic](https://console.anthropic.com), [OpenAI](https://platform.openai.com), or [Google AI Studio](https://aistudio.google.com/app/apikey) also work fine. You can add more providers later.

### Step 1 — Install Obsidian and create a vault

1. Download Obsidian from <https://obsidian.md/download> and install it like any normal desktop app.
2. Launch Obsidian. From the welcome screen choose **Create new vault**.
3. Pick a folder somewhere stable (e.g. `~/Documents/MyVault`). Open it.
4. Once the empty vault is open, quit Obsidian. We'll come back to it after Hermes is running — opening it now is fine too, but the plugin can't load until step 4.

> **Where is my vault?** Whatever folder you picked above. From this point on, `<VAULT>` in this tutorial means that folder. Everything plugin-related will live under `<VAULT>/.obsidian/`.

### Step 2 — Install and configure Hermes

Hermes is a standalone CLI/gateway you install once per machine. It is the *brain* of this setup — the plugin is just a frontend.

#### 2.1 Run the installer

```bash
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
```

The installer is interactive and handles platform-specific setup (uv, Python, dependencies). When it finishes, reload your shell so `hermes` ends up on your PATH:

```bash
source ~/.zshrc       # or ~/.bashrc, depending on your shell
hermes --version      # should print something like "Hermes Agent v0.11.0"
```

If `hermes --version` fails, open a new terminal window and try again, or check the [Hermes Quickstart](https://hermes-agent.nousresearch.com/docs/getting-started/quickstart) for shell-specific notes.

#### 2.2 Run the setup wizard

```bash
hermes setup
```

This is an interactive wizard. The defaults are fine for almost every prompt. Pay attention to these sections:

- **Model / provider** — Pick a provider you have an API key for. If you chose OpenRouter, paste the key from <https://openrouter.ai/keys> when asked, and pick a sensible default model (e.g. `anthropic/claude-sonnet-4` or whatever's current).
- **Gateway** — Say **yes** to enabling the gateway. The gateway is the local HTTP server the plugin talks to. The wizard will set `API_SERVER_ENABLED=true`, generate an `API_SERVER_KEY`, and write everything to `~/.hermes/.env`.
- **Tools** — Accept the defaults; you can refine later with `hermes tools`.

When the wizard finishes, verify with:

```bash
hermes status
```

You should see a green checkmark next to the chosen provider and the gateway URL. Note the `API_SERVER_HOST` and `API_SERVER_PORT` lines — the plugin auto-detects these from `~/.hermes/.env`, but it's good to know what they are. Defaults are usually `localhost:8080`.

If anything is red, run `hermes doctor` — it prints precise repair instructions.

#### 2.3 Start the gateway as a background service

The plugin can only talk to Hermes when the gateway is running. To make the gateway start automatically every time you log in:

```bash
hermes gateway install     # installs a launchd / systemd unit
hermes gateway start       # starts it now
hermes gateway status      # should say: ✓ running
```

If you'd rather not run a background service, you can run `hermes gateway run` in a terminal whenever you want to chat — but you'll need to keep that terminal open.

#### 2.4 Smoke-test the gateway

Before touching the plugin, confirm the gateway responds to HTTP. Replace `<KEY>` with the value of `API_SERVER_KEY` from `~/.hermes/.env`:

```bash
curl -s http://localhost:8080/v1/models \
  -H "Authorization: Bearer <KEY>" | head -c 200
```

You should get back JSON listing available models. If you get **connection refused**, the gateway isn't running — go back to step 2.3. If you get **401**, the key in your curl command doesn't match `~/.hermes/.env`. If both look right, run `hermes doctor`.

Once this curl works, the hardest part is done.

### Step 3 — Install the Obsidian Agents plugin

The plugin is a community plugin distributed as source. You clone it into your vault's plugin folder and build it locally.

```bash
# 1. Make the plugin folder if it doesn't exist yet
mkdir -p "<VAULT>/.obsidian/plugins"

# 2. Clone into it under the canonical folder name
cd "<VAULT>/.obsidian/plugins"
git clone https://github.com/Zibhelina/obsidian-agents.git obsidian-agents

# 3. Build the bundle
cd obsidian-agents
npm install
npm run build
```

After `npm run build`, you should see a freshly compiled `main.js` in the plugin folder. That's what Obsidian actually loads.

> **The folder name matters.** Obsidian uses the folder name as the plugin ID. It must be `obsidian-agents` — the same as the `id` in `manifest.json` — or the plugin won't load.

### Step 4 — Enable the plugin in Obsidian

1. Open Obsidian and switch to your vault.
2. Go to **Settings → Community plugins**. If this is a new vault, Obsidian will ask you to **turn off Restricted mode** — do that.
3. Under **Installed plugins**, you should see **Obsidian Agents**. Toggle it on.
4. A new ribbon icon (a message circle) appears on the left edge. Click it to open the chat workbench in the right sidebar.

If you don't see the plugin in the list, the folder name is wrong (it must be `obsidian-agents`), or the build failed. Re-run `npm run build` in the plugin folder and check for errors.

### Step 5 — First conversation

You should now see the empty chat workbench. Try this checklist — each item exercises a different subsystem so any breakage is easy to localize.

1. **Hello world.** Type "hi" and press `Cmd/Ctrl+Enter`. You should see streaming tokens within a second or two. If you see "Cannot reach Hermes gateway", the gateway isn't running (`hermes gateway start`). If you see a 401 error, run `hermes setup gateway` to regenerate the key.
2. **Model picker.** Click the model name in the bottom bar of the composer. Pick a different provider/model. It writes to `~/.hermes/config.yaml` and applies on the next message.
3. **Effort level.** In the same picker, set reasoning effort. Send a message that warrants it ("explain how SSL handshakes work in detail") and confirm the reasoning panel ticks a live timer above the reply.
4. **Mentions.** Create a note in the vault (`Cmd/Ctrl+N`), write a paragraph, save it. Back in the chat, type `@` and start typing the note's name — pick it from the popover. Ask "summarize @[note]". The model should respond as if it knows about the file (it received it as a `ctx_n` reference; it can read the bytes via tools).
5. **Image paste.** Take a screenshot, copy it, paste into the composer with `Cmd/Ctrl+V`. A thumbnail chip appears. Ask "describe what's in this image". You'll see the proxy image was attached for this turn only.
6. **Skill.** Type `/` to see the skill popover. Pick `tutor`, then ask it to teach you something. The skill's system prompt is now active for this turn.
7. **Context debugger.** Hover an agent message and click the **debug** action. The three-tab modal shows exactly what was sent to the model, with token estimates per block.

If all seven work, you have the same setup the author uses.

### Step 6 — (Optional) Verify the callback server

Some skills (notably `/automation`) schedule background jobs whose results come back via a local HTTP server the plugin runs. To confirm it's working:

1. Open **Settings → Obsidian Agents → Background-job callback server**. The "Current endpoint" line should show a `http://127.0.0.1:<port>` URL.
2. Note the token under the same section.
3. From a terminal, simulate a job firing:
   ```bash
   curl -s -X POST "http://127.0.0.1:<port>/callback" \
     -H "Authorization: Bearer <TOKEN>" \
     -H "Content-Type: application/json" \
     -d '{"channel":"notice","payload":{"content":"hello from cron"}}'
   ```
4. You should see a toast notification pop up in Obsidian saying "hello from cron".

If the toast appears, the gateway will be able to deliver scheduled-job results into your chats, notes, or as toasts.

### Step 7 — (Optional) Customize

Now that everything works, you can tune things to taste:

- **Add more providers.** Run `hermes login <provider>` (OAuth) or `hermes auth add` (API key). They show up in the model picker on the next launch.
- **Change approval mode.** Settings → Obsidian Agents → Approval mode. `manual` is safest; `smart` is the author's daily driver; `off` is `--yolo`.
- **Author your own skill.** Create `<VAULT>/.obsidian/plugins/obsidian-agents/src/skills/my-skill.ts` following the shape of `tutor.ts`, register it in `index.ts`, and run `npm run build`. The composer's `/` popover picks it up automatically.
- **Run the dev watcher.** `npm run dev` in the plugin folder keeps `main.js` in sync as you edit `.ts` files. Reload Obsidian (`Cmd/Ctrl+R`) to pick up the rebuilt bundle.

### Troubleshooting matrix

| Symptom | Likely cause | Fix |
|---|---|---|
| Plugin doesn't appear in Community plugins list | Folder name isn't `obsidian-agents`, or build failed. | Rename the folder; re-run `npm run build`; check for errors. |
| Plugin loads but "Cannot reach Hermes gateway" | Gateway isn't running. | `hermes gateway start`; then `hermes gateway status`. |
| 401 / Unauthorized from gateway | API key drifted between `~/.hermes/.env` and the plugin. | Leave the plugin's "Hermes API key" setting blank and re-run `hermes setup gateway`. |
| Model picker is empty | Gateway is up but no provider is authenticated. | `hermes status` to see which providers are red; `hermes login <provider>` or `hermes auth add` to fix. |
| Reasoning panel is empty for some models | The model doesn't expose reasoning, or expose it in a non-standard field. | Try a model known to stream reasoning (Anthropic Sonnet/Opus with effort ≥ medium, GPT-4o-style models). |
| Image attached but model "didn't see it" | Current-turn payload was dropped by the 80% budget guard. | Use a model with a larger context window, or reduce other context (close older messages, drop mentions). |
| Mentions render as raw `@[name](path)` text in old chats | Pre-rebrand chat. | New chats render fine; old ones are transcript-frozen by design. |
| Plugin updates don't take effect | Obsidian is still running the old `main.js`. | Run `npm run build`, then toggle the plugin off/on (or reload Obsidian). |

If you get stuck, `hermes doctor` is usually the fastest diagnosis, followed by `hermes status` and the plugin's own **Context debugger** modal (which shows what was actually sent).

---

## Installation and development

Obsidian Agents is **desktop-only** (it uses Node's `http`, `fs`, and similar). Mobile Obsidian is not supported.

### From source

```bash
cd /path/to/your/vault/.obsidian/plugins/
git clone https://github.com/Zibhelina/Obsidian-Agent-Chat.git obsidian-agents
cd obsidian-agents
npm install
npm run build
```

Then enable **Obsidian Agents** under **Settings → Community plugins**.

### Development loop

```bash
npm run dev    # watcher rebuilds main.js on every change
```

Obsidian only loads the compiled `main.js`, never the `.ts` sources, so you must rebuild after every TypeScript edit. The `dev` script keeps a watcher running for you. To pick up the new bundle, either toggle the plugin off/on in settings or reload Obsidian (`Cmd/Ctrl+R`).

### Build pipeline

- TypeScript sources under `src/` compile via [esbuild](https://esbuild.github.io/) (`esbuild.config.mjs`) into a single `main.js` at the plugin root.
- `main.ts` is a one-line re-export of `src/plugin.ts` because Obsidian expects `main.js` to default-export the `Plugin` class.
- `manifest.json`, `styles.css`, and `main.js` are the only files Obsidian loads at runtime.

---

## Settings reference

The Settings tab is kept deliberately small — most "settings" you'd expect (provider, model, API keys) live in `~/.hermes/config.yaml` so all Hermes clients agree.

| Setting | What it does |
|---|---|
| **Agent name** | Display name for the AI (default "Hermes"). |
| **Provider / model** | Read-only view of the active Hermes route. Change it from the composer's model picker, which writes to `~/.hermes/config.yaml`. |
| **Effort level** | Reasoning effort sent on the next message (`minimal` / `low` / `medium` / `high`). Mirrored to Hermes config. |
| **Hermes gateway URL** | Override the default `http://localhost:8080/v1`. Leave blank to auto-detect from `~/.hermes/.env`. |
| **Hermes API key** | Override `API_SERVER_KEY` from `~/.hermes/.env`. |
| **Approval mode** | `manual` (prompt on every dangerous command), `smart` (LLM-judged), `off` (`--yolo`). Mirrored to Hermes config. |
| **Callback server** | Enable/disable; host (default `127.0.0.1`), port (`0` = auto-pick), shared-secret token (auto-generated). |

On load, the plugin **reconciles** its in-memory `approvalMode` and `effortLevel` with whatever Hermes config currently says, because the CLI, TUI, or Telegram clients might have changed them between sessions.

---

## Architecture overview

```
main.ts                          — entry shim (re-exports src/plugin.ts)
manifest.json                    — Obsidian plugin manifest
styles.css                       — Obsidian-loaded stylesheet (theme-aware)
esbuild.config.mjs               — bundle config
src/
  plugin.ts                      — Plugin class: lifecycle, sessions, send flow, settings tab
  types.ts                       — All shared TypeScript types
  settings.ts                    — Settings load/save helpers
  storage.ts                     — Session/folder JSON persistence + trace compaction hook
  hermes.ts                      — Hermes gateway: request build, SSE streaming, system prompt
  contextDebug.ts                — Parse plugin / Hermes / OpenAI Responses payloads into labeled blocks
  traceArtifacts.ts              — Archive reasoning/tool/debug payloads to disk by reference
  tokenizer.ts                   — Naive ~4-chars-per-token estimator
  lib/
    agentVaultRuntime.ts         — Safe paths and binary/text writes under agent-vault/
    hermesConfig.ts              — Read/write ~/.hermes/config.yaml
    hermesProviders.ts           — Provider/auth catalog for the model picker
    modelsCache.ts               — Cache of available models from the Hermes gateway
    vault.ts                     — Vault search and file helpers
    layout.ts                    — Parse "position=…" fence attributes for layout blocks
    costEstimation.ts            — Per-model pricing for the stats bar
    id.ts                        — Random ID generator
  features/
    mentions.ts                  — Parse @[label](path) inline mention tokens
    contextBundle.ts             — Build ContextItem records, derivatives, bundle JSON
    attachments.ts               — Paste / drag-drop / file capture, chip preview rendering
    commands.ts                  — Thin shim that exposes the skill registry as slash commands
    applets.ts                   — Pluggable inline applet registry (legacy/extension hook)
  skills/
    index.ts                     — Skill registry (canonical list of slash skills)
    types.ts                     — Skill interface
    *.ts                         — One file per skill
  callback/
    server.ts                    — Local HTTP server (token-auth, JSON only)
    channels/
      index.ts                   — ChannelRegistry, built-in registrations
      types.ts                   — DeliveryChannel / DeliveryContext interfaces
      chat.ts, newChat.ts,       — Built-in delivery channels
      note.ts, notice.ts
  ui/
    ChatView.ts                  — Main ItemView: orchestrates panels and stream handlers
    components/
      Sidebar.ts                 — Session/folder tree with drag-drop, unread dots
      Composer.ts                — Editor + skill chips + attachments + model picker
      LivePreviewEditor.ts       — CodeMirror 6 wrapper with markdown decorations + chip widgets
      MentionPopover.ts          — @-popover for vault files
      MessageList.ts              — Scroll-aware list of bubbles
      MessageBubble.ts           — User/agent bubble with thinking trace + attachments
      ThinkingTrace.ts           — Reasoning + tool-call timeline drawer
      ContextDebugModal.ts       — Blocks / Raw JSON / Stats inspector
      ModelPicker.ts             — Provider / auth / model selector (writes Hermes config)
      LayoutEngine.ts             — Markdown + applets + rich-layout renderer
      rich-layouts.ts            — Hero / gallery / carousel / map / split / cards / terms
      TermPanel.ts               — Slide-in glossary detail panel
      PermissionWidget.ts        — Inline tool-approval applet
      SessionStatsBar.ts         — Token + cost info popover
      ChatNavigator.ts           — Minimap rail of user-message dots
      StatusBar.ts, ReplyHandle.ts, TermPanel.ts
```

### Layered responsibilities

1. **Plugin layer (`plugin.ts`, `settings.ts`, `storage.ts`)** — Owns sessions, folders, the active stream registry, callback server lifecycle, and the settings tab. It is the only place that orchestrates the send flow end-to-end.
2. **Transport layer (`hermes.ts`)** — Translates `ChatMessage[]` into an OpenAI-compatible request, streams Server-Sent Events back, splits `<thinking>` tags out of content, and emits typed events to handlers (`onToken`, `onThinking`, `onToolCall`, `onContextDebug`, `onComplete`).
3. **Context layer (`features/contextBundle.ts`, `traceArtifacts.ts`, `contextDebug.ts`)** — Pre- and post-processes the request: builds context bundles before send, archives traces after complete.
4. **UI layer (`ui/`)** — Pure rendering and input. Talks to the plugin via callbacks and Obsidian's workspace API; receives stream updates via `StreamHandlers` injected by the plugin.

State is split deliberately: **the plugin owns session data**; **`ChatView` owns view state** (which session is open, which panels are showing); **child components own local UI state** (composer draft, popover visibility, modal navigation).

---

## The send flow, step by step

The send flow is the spine of the plugin. Reading this once gives you a working mental model.

1. **User hits send.** `Composer` collects the raw editor text, the active attachment list, and the active skill IDs, and calls `plugin.sendMessage(sessionId, text, attachments, handlers, skillIds)`.
2. **Context bundle is built.** `buildContextBundle()` (in `features/contextBundle.ts`):
   - Parses `@[label](path)` inline mentions, resolves them against the vault, and replaces each token with `[ctx_n: name]`.
   - For each pasted/dropped attachment, writes the original bytes to `agent-vault/runtime/attachments/<sessionId>/<messageId>/originals/`.
   - For images (except SVG), generates a JPEG visual proxy (max 1280px edge, quality 0.85) under `agent-vault/runtime/derivatives/`.
   - Assembles a versioned `ContextBundle` JSON file and writes it to `agent-vault/runtime/context-bundles/<sessionId>/<messageId>.json`.
3. **Two messages are created.**
   - The **stored** `ChatMessage` keeps the *raw user text*, durable attachment paths, and a compact `contextBundleRef`. No base64 blobs.
   - The **API-only** message has its `content` rewritten to include `[ctx_n]` references followed by a `<context_bundle version="1">…</context_bundle>` JSON block, plus the visual proxies as `image_url` parts for *this turn only*.
4. **Agent placeholder is pushed.** An empty assistant `ChatMessage` is appended and registered in `activeStreams` keyed by `sessionId` (so multiple sessions can stream concurrently without colliding).
5. **Request is built (`hermes.ts → buildMessages`).** The system prompt is composed from:
   - The base `OBSIDIAN_AGENTS_SYSTEM_PROMPT` (capability declarations: applets, rich layouts, reasoning trace, markdown rules).
   - A **runtime metadata** block (local time, UTC, timezone, active provider/model/base URL).
   - A **file handling policy** block (warns the model that file refs ≠ inspected files).
   - **Archived trace pointers** for prior assistant messages so the model knows where to look if it needs old reasoning.
   - **Active skills**' system prompts concatenated in order.
   - A **runtime callback** block (session ID, callback URL, callback token) only if at least one active skill has `injectCallbackContext: true`.
   Each message is then transformed: only the **current** turn carries inline `image_url` / `input_audio` parts; historical messages are flattened to text with an `<attachment_context_refs>` block listing IDs, kinds, paths, and statuses.
6. **Budget guard.** If the estimated tokens (`JSON.stringify(messages)` → `estimateTokens`) exceed 80% of the configured context window *with* current-turn binary parts, the request is rebuilt without them and the omission reason is surfaced in the prompt so the model doesn't lie about having seen them.
7. **Request is sent.** A streaming SSE request goes to the Hermes gateway (`POST <gateway>/chat/completions` with `stream=true`). Auth is `Authorization: Bearer <API_SERVER_KEY>`.
8. **Events stream in.** `parseSSE` chunks the response. A stateful `ThinkingStripper` routes content inside `<thinking>` / `<think>` / `<reasoning>` tags to `onThinking` so models that inline raw tags (Qwen, DeepSeek, some Ollama builds) still get proper reasoning routing. Reasoning fields like `delta.reasoning` and `delta.reasoning_content` are honored too.
9. **The UI mutates in place.** `wrappedHandlers` in `plugin.ts` writes incoming tokens onto `agentMsg.content`, attaches `thinking` / `toolCalls` / `contextDebug` to its metadata, and forwards each event to `ChatView`. The bubble re-renders synchronously per event.
10. **Stream completes.** `onComplete` records `durationMs` and final usage, deletes the session's entry from `activeStreams`, and triggers `saveSessionsData()`.
11. **Trace archival.** `storage.ts → saveSessions → compactSessionsForStorage` walks every message; any assistant message whose metadata has `thinking`, `toolCalls`, or `contextDebug` gets serialized to `agent-vault/traces/<sessionId>/<messageId>.trace.json` and replaced in memory with a compact `traceRef` pointer.

The end result: the model saw a structured, deduplicated, budget-aware request; the user sees a clean transcript; the disk holds full audit trails.

---

## Context bundles and attachments

This is the heart of the plugin's context hygiene.

### Why bundles exist

A naive chat plugin pastes the body of every mentioned file into the request, base64-encodes every image on every turn, and lets the context window explode. That is wasteful, expensive, and makes the model less accurate (more irrelevant tokens). Obsidian Agents replaces that pattern with **metadata-first context**.

### The `ContextItem` model

Every mention, paste, drop, screenshot, or direct attachment becomes a `ContextItem`:

```ts
interface ContextItem {
  id: string;                   // stable per-request, e.g. "ctx_1"
  source: "mention" | "attachment" | "paste" | "drop" | "screenshot";
  kind: "text" | "image" | "pdf" | "audio" | "video" | "csv" | "binary" | "folder" | "unknown";
  name: string;
  status: "available_not_loaded" | "included_text" | "included_visual_proxy"
        | "included_audio"      | "referenced_not_inlined" | "failed";
  original?: { localPath; vaultPath; mime; sizeBytes; width; height };
  derivatives?: ContextDerivative[];  // e.g. a JPEG visual proxy
  // …
}
```

A bundle is `{ version: 1, sessionId, messageId, createdAt, items: ContextItem[] }` and is rendered into the user message as a single `<context_bundle>` JSON block.

### What the model sees

```
Compare [ctx_1: README.md] with [ctx_2: screenshot.png].

<context_bundle version="1">
{ "items": [
    {"id":"ctx_1","kind":"text","name":"README.md","status":"available_not_loaded","original":{...}},
    {"id":"ctx_2","kind":"image","name":"screenshot.png","status":"included_visual_proxy","derivatives":[...]}
  ]
}
</context_bundle>
```

…followed by `image_url` / `input_audio` content parts for items whose status is `included_visual_proxy` / `included_audio`, **but only for the current turn**.

### Attachment lifecycle

- **Paste / drop**: bytes are encoded to a data URL and downscaled if larger than ~900 KB (images get resampled to 1280px / quality 0.8) so the request body stays under the gateway's ~1 MB limit.
- **Originals** are persisted to `agent-vault/runtime/attachments/<sessionId>/<messageId>/originals/` with collision-safe filenames.
- **Derivatives** (currently: image visual proxies) go to `agent-vault/runtime/derivatives/<sessionId>/<messageId>/`.
- **Stored attachment metadata** carries durable paths, MIME, size, and source — *not* the data URL once the durable file exists.
- **On later turns**, historical attachments become an `<attachment_context_refs>` block listing IDs, types, paths, and sizes. The model is told explicitly: a reference is not an inspection.

### Mentioned files vs. direct attachments

- **Mentions are metadata-first.** They show up as `[ctx_n: name]` references with `status: "available_not_loaded"`. The model can ask to read them with a tool. They are not auto-inlined.
- **Pasted/dropped media are content-first.** Images and audio get inline content parts on the current turn, within the budget guard, because the user clearly intends them to be inspected right now.

### Budget guard

Before sending, the plugin estimates the request's token cost. If inline image/audio content would push the request past **80% of the configured context window**, those parts are dropped, the message falls back to references, and the system prompt notes the omission reason so the model behaves honestly.

---

## Trace archival and context hygiene

Models also pay tokens for the **previous turns** in the conversation. Reasoning content and tool outputs are the worst offenders: they can be tens of thousands of characters per turn.

The plugin archives them by reference:

- Whenever sessions are saved (`storage.ts`), `compactSessionsForStorage` walks every assistant message.
- Any message with `metadata.thinking`, `metadata.toolCalls`, or `metadata.contextDebug` gets serialized to `agent-vault/traces/<sessionId>/<messageId>.trace.json`.
- In-memory metadata is then stripped of the full payloads and replaced with a compact `traceRef` pointer (path + counts).
- On future requests, `buildTraceReferenceBlock` builds an **archived activity trace pointers** section of the system prompt listing the most recent ~25 archived traces by path + counts, so the model knows what was done and where to look it up if needed.
- The reasoning drawer in the UI still renders the compact pointer (so users can find the file), but the original full text is no longer in the active chat context.

**Net effect**: a 100-message session with rich tool use stays compact in memory and on the request, while remaining fully auditable on disk.

---

## Inline mentions

The composer stores mentions as **plain text**:

```
@[Display Name](vault/path.md)
```

This is the canonical syntax and it is preserved through copy/paste, undo/redo, and persistence. The magic happens at three layers:

1. **MentionPopover** triggers when you type `@` followed by non-whitespace. It fuzzy-searches vault files and folders and inserts the canonical token on selection.
2. **LivePreviewEditor** (a CodeMirror 6 wrapper) decorates tokens *outside* the cursor as inline chip widgets, but reveals the raw editable text *inside* the cursor. The chip resolves the path; missing files render in a red error state.
3. **`features/mentions.ts`** parses tokens on send. It supports three fallback shapes (markdown link with `@` prefix, quoted, and a simple boundary-checked `@filename`), handles escaped brackets/parens/backslashes, and produces `ParsedMentionOccurrence` records with start/end offsets so the text can be safely rewritten to `[ctx_n: name]` references.

The result is a composer that *feels* like rich-text mention chips but is *actually* just well-formatted Markdown.

---

## Skills (slash commands)

Skills are **on-demand prompt modules** that the user selects per turn. They are not plugins, not middleware, and not tools — they are extra system-prompt fragments that get appended only when active.

### Registry

`src/skills/index.ts` exports a `SKILLS` array and a `SkillRegistry` class with `get(id)`, `list()`, and `filter(query)` methods. The Composer's `/`-popover and `MentionPopover` for skills both filter through this registry.

### Skill shape

```ts
interface Skill {
  id: string;                       // kebab-case, no leading slash
  label: string;                    // popover title
  description: string;              // popover subtitle
  systemPrompt: string;             // appended to the system message when active
  icon?: string;                    // Lucide icon name (default: "sparkles")
  placeholder?: string;             // composer placeholder when active
  injectCallbackContext?: boolean;  // include session/callback runtime block
  kind?: "core" | "custom";         // ships with plugin vs user-authored
}
```

When the user activates skills (up to 3 chips), their IDs are passed to `plugin.sendMessage(...)`, threaded through `RuntimeContext.skillIds`, and concatenated into the system prompt in `hermes.ts`. The callback runtime block is only attached if **any** active skill needs it.

### Built-in skills

| Slash | Label | What it does |
|---|---|---|
| `/automation` | Automation | Schedule deferred work; emits callback URL into the system prompt. |
| `/blog` | Blog project | Project-context mode for the author's blog repo. |
| `/dynamic-layout` | Dynamic layout | Tells the agent to position media/applets explicitly. |
| `/wiki` | Wiki | Extract and link to vault notes with strong cross-referencing. |
| `/applet` | Applet | Builds high-quality interactive HTML/React applets with design guardrails. |
| `/tutor` | Socratic Tutor | Strict Socratic teaching, first-principles, no direct homework answers. |
| `/web` | Web search | Forces grounded web search with citations. |
| `/manage-skills` | Manage skills | Edits the user's custom skills directly via filesystem. |
| `/self-improve` | Self-improve | Lets the agent edit *this plugin's* source; explains the build loop and verification steps. |
| `/strategist` | Strategist | Strategic decision-making and planning. |
| `/transcribe-audio` | Transcribe audio | Convert audio files to text. |

### Self-improvement

`/self-improve` is the most reflexive skill: it documents the plugin's layout, build pipeline, type-check & verify steps, and forbids inventing new `Skill` fields. The agent reads this prompt and can then edit the plugin's own source — making the project, to a real degree, an agent that maintains itself.

---

## Background-job callback server

Some skills (notably `/automation`) need to **schedule** work that completes later — a job that fetches data on a cron, a long-running deep-research task delegated to the gateway, or a follow-up reminder. When that work completes, the result must come *back* into Obsidian.

The plugin solves this by running a tiny local HTTP server.

### Lifecycle

- Starts on plugin load if `callbackEnabled` is true.
- Binds to `callbackHost` (default `127.0.0.1`) on `callbackPort` (default `0` = OS-assigned ephemeral).
- Auto-generates a `callbackToken` on first run if blank.
- Stops cleanly on `onunload` so no socket is leaked across plugin reloads.

### Auth

Token-based. Every request must present `Authorization: Bearer <token>` (or a `?token=…` query param). Mismatches return `401`.

### Channels (pluggable delivery drivers)

`ChannelRegistry` maps channel IDs to `DeliveryChannel` implementations:

```ts
interface DeliveryChannel {
  id: string;
  describe: string;
  deliver(ctx: DeliveryContext, req: DeliveryRequest): Promise<void>;
}
```

Built-in channels:

| Channel | What it does |
|---|---|
| `chat` | Appends the result as a new agent message in the session that scheduled it; falls back to a new chat if the session was deleted. |
| `new-chat` | Creates a fresh session and posts the result there; surfaces a `Notice` so the user notices. |
| `note` | Appends to a vault markdown file (auto-creates parent folders, sanitizes paths to block traversal). |
| `notice` | Shows the result as a transient toast (10s). |

Channels are open: drop a file into `src/callback/channels/` implementing `DeliveryChannel` and register it in `src/callback/channels/index.ts`.

### Request shape

Single delivery:

```json
POST http://127.0.0.1:<port>/callback
Authorization: Bearer <token>
Content-Type: application/json

{
  "channel": "chat" | "new-chat" | "note" | "notice",
  "sessionId": "<id>",
  "target": "Daily/Summary.md",
  "payload": { "content": "...", "title": "optional", "metadata": { ... } }
}
```

Batch (one job → many destinations):

```json
{ "deliveries": [ { "channel": "chat", ... }, { "channel": "note", ... } ] }
```

Responses: `200 {ok:true,channel}` on success, `207` on partial-success batches, `400` for bad input, `401` for bad token, `500` for delivery errors.

### How the agent learns the URL

The Hermes system prompt has a **Runtime context** block injected (only when a skill with `injectCallbackContext: true` is active):

```
OBSIDIAN_AGENTS_SESSION_ID=<uuid>
OBSIDIAN_AGENTS_CALLBACK_URL=http://127.0.0.1:<port>/callback
OBSIDIAN_AGENTS_CALLBACK_TOKEN=<token>
```

The agent reads those, schedules a job with the gateway, the gateway POSTs to the callback URL when the job fires, and the result lands in the right place — no polling, no agent state, no leaked credentials.

---

## Rich layouts and applets

Two related capabilities for visually rich replies.

### Inline applets

The agent can emit a fenced code block with language `obsidian-agents-applet` (raw HTML/JS) or `obsidian-agents-react` (React 18). The fence info line accepts `position=inline|left|right|above|below`, `width=...`, and `height=...`. The `LayoutEngine` extracts these and mounts each applet as a **sandboxed iframe** with:

- Theme variables (`--background-primary`, `--text-normal`, etc.) injected as CSS custom properties so applets blend with the user's Obsidian theme.
- React 18 and `createRoot` pre-imported for `obsidian-agents-react`.
- Auto-mounting: if the block assigns `App = ...`, the renderer mounts it via `createRoot`; if the block calls `createRoot` itself, it isn't double-mounted.
- ES module imports allowed via full CDN URLs (`https://esm.sh/three`, `https://esm.sh/d3`, etc.).

Applets are not just decoration — the system prompt has explicit product-quality guardrails ("treat applets like small product artifacts, not decorative code snippets") covering states, accessibility, theme compliance, and motion discipline.

### Rich layout blocks

For media-heavy non-interactive replies, the agent uses JSON-driven fence blocks rendered by `rich-layouts.ts`:

| Fence | What it renders |
|---|---|
| `obsidian-agents-hero` | One large image + 1-2 stacked thumbnails (Wikipedia-style opener). |
| `obsidian-agents-gallery` | Responsive image grid. |
| `obsidian-agents-carousel` | Horizontal scroller with arrows and counter. |
| `obsidian-agents-map` | Leaflet map with rating-style pins. |
| `obsidian-agents-card-list` | Vertical list of cards (title, rating, body, thumbnail). |
| `obsidian-agents-split` | Visual on one side, prose on the other. |
| `obsidian-agents-terms` | Silent glossary — adds click-to-open detail panels to inline `[[Label]]{#slug}` markers. |

### Term glossary

A reply can sprinkle inline `[[Term]]{#slug}` markers that the renderer turns into clickable pills. Clicking opens `TermPanel`, a slide-in right-side panel with the term's hero image, summary, key facts, free-form markdown sections, and source links — driven by the `obsidian-agents-terms` block elsewhere in the same reply.

---

## Context debugger

A three-tab modal you can open per assistant message:

- **Blocks** — Every entry in the request, labeled by type (`system`, `developer`, `user`, `assistant`, `tool_call`, `tool_schema`, `tool_result`, `attachment`, `mention_context`, `summary`, `unknown`), with token estimates, role, source, and full content. Searchable; small blocks auto-expand.
- **Raw JSON** — The full request payload, copyable to clipboard.
- **Stats** — Token usage bar against the configured context window, estimated cost (current message + session total), compaction details, omitted message count, and any warnings.

The debugger understands **two payload shapes**:

- OpenAI chat-completions style (`messages: [...]`)
- OpenAI Responses API style (`input: [...]`)

It carefully distinguishes **current-request tool schemas** (declarations of capability) from **historical tool calls / tool results** (actual past activity) — because they have very different semantic meaning even though they look similar in raw form.

---

## Storage layout and runtime artifacts

```
.obsidian/
├── obsidian-agents-sessions.json          ← sessions + folders + compact messages
└── plugins/obsidian-agents/
    ├── main.js, manifest.json, styles.css  ← what Obsidian loads
    └── agent-vault/                        ← gitignored runtime artifacts
        ├── runtime/
        │   ├── attachments/<sessionId>/<messageId>/originals/   ← pasted/dropped originals
        │   ├── derivatives/<sessionId>/<messageId>/             ← JPEG visual proxies
        │   └── context-bundles/<sessionId>/<messageId>.json     ← per-message bundle JSON
        └── traces/<sessionId>/<messageId>.trace.json            ← archived reasoning + tool calls
```

Both the vault root `.gitignore` and the plugin's `.gitignore` exclude `agent-vault/` so private runtime artifacts never leak. A one-time migration converts pre-rebrand `agentchat-sessions.json` to the current name, and another migration on load rewrites any legacy persisted base64 attachment blobs into durable agent-vault files + compact refs.

Sessions are persisted only when they contain at least one user message — empty "New Chat" entries stay in memory so the sidebar doesn't fill with cruft.

---

## Module map

A quick reference of where to look when you want to change something.

- **Change the system prompt** → `src/hermes.ts` (`OBSIDIAN_AGENTS_SYSTEM_PROMPT` and the `build…Block` helpers).
- **Add a new skill** → drop a `.ts` file in `src/skills/`, register it in `src/skills/index.ts`.
- **Add a callback channel** → drop a `.ts` file in `src/callback/channels/`, register it in `src/callback/channels/index.ts`.
- **Add a new rich-layout fence** → extend `src/ui/components/rich-layouts.ts` and the layout switch in `LayoutEngine.ts`.
- **Change attachment downscale rules** → `MAX_IMAGE_DATAURL_CHARS`, `RESAMPLE_MAX_EDGE`, `RESAMPLE_QUALITY` in `src/hermes.ts`, plus `createImageDerivative` in `src/features/contextBundle.ts`.
- **Change the budget guard** → `ATTACHMENT_INLINE_CONTEXT_RATIO` in `src/hermes.ts`.
- **Change session persistence** → `src/storage.ts` (file path, compaction wiring).
- **Change which metadata gets archived** → `hasTracePayload` and `compactMessageForStorage` in `src/traceArtifacts.ts`.
- **Change cost estimates** → `src/lib/costEstimation.ts`.
- **Tweak composer behavior** → `src/ui/components/Composer.ts` and `LivePreviewEditor.ts`.

---

## Glossary

- **Hermes** — A local LLM gateway with an OpenAI-compatible API. Routes requests to providers (Anthropic, OpenAI, OpenRouter, local models, etc.), handles credentials, and executes tools. Obsidian Agents is a frontend; Hermes is the brain.
- **Skill** — A slash-command-activated system-prompt module. Not a tool, not a plugin — just extra context appended when the user opts in.
- **ContextItem** — A normalized record describing one piece of context (a mention, an attachment, a screenshot) sent to the model.
- **ContextBundle** — A versioned JSON envelope of `ContextItem`s persisted to disk and rendered into the model-facing user message.
- **Visual proxy** — A downscaled JPEG derivative of an image, used as the model-facing version so the original (which might be a 20 MB PNG) doesn't get sent.
- **Trace artifact** — A JSON file under `agent-vault/traces/` holding archived reasoning, tool calls, and debug snapshots for one assistant message.
- **Steering queue** — Buffer of user messages typed during streaming, coalesced into the next turn when the current stream finishes.
- **Approval mode** — Hermes-level policy for dangerous commands: `manual`, `smart`, or `off`. Lives in `~/.hermes/config.yaml`.
- **Callback channel** — A pluggable destination (`chat`, `new-chat`, `note`, `notice`) where a scheduled job's result can be delivered.
- **Agent vault** — The `agent-vault/` directory inside the plugin folder, gitignored, holding all runtime artifacts (originals, derivatives, bundles, traces).

---

## Author and license

Joao Henrique Costa Araujo — [@Zibhelina](https://github.com/Zibhelina).
MIT — see [LICENSE](./LICENSE).
