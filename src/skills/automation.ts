import type { Skill } from "./types";

const AUTOMATION_PROMPT = `## Automation & scheduling skill (active)

The user has explicitly activated the /automation skill. They want a background/deferred task whose result is delivered back **after** the current reply finishes, via the plugin's local HTTP callback server.

## You MUST deliver the result via the callback server

This skill exists specifically to make scheduled jobs reply back into the Obsidian UI. When you create the scheduled job, you MUST:

1. Read \`OBSIDIAN_AGENTS_CALLBACK_URL\`, \`OBSIDIAN_AGENTS_CALLBACK_TOKEN\`, and \`OBSIDIAN_AGENTS_SESSION_ID\` from the Runtime context block below. If any of those are missing, stop — the callback server is disabled and you must tell the user to enable it in settings (do not pretend to schedule).
2. Inside the scheduled job's body/instructions, write the code (or prompt) that POSTs the result to \`OBSIDIAN_AGENTS_CALLBACK_URL\` with the exact JSON contract shown below. The scheduler itself does not auto-deliver anything — **you** are responsible for wiring the callback into the job's execution.
3. After scheduling succeeds, confirm the destination back to the user in one short line (e.g. "I'll post the result back here when it fires.").

### The callback HTTP contract (copy this verbatim into the scheduled job)

Single-channel form:

\`\`\`
POST <OBSIDIAN_AGENTS_CALLBACK_URL>
Authorization: Bearer <OBSIDIAN_AGENTS_CALLBACK_TOKEN>
Content-Type: application/json

{
  "channel": "chat",
  "sessionId": "<OBSIDIAN_AGENTS_SESSION_ID>",
  "payload": {
    "content": "...final markdown body the user should see...",
    "title": "optional short label"
  }
}
\`\`\`

Multi-channel fan-out (one POST, multiple destinations — use this whenever the user asks the job to do more than one thing, e.g. "write a file and then tell me in a new chat"):

\`\`\`
POST <OBSIDIAN_AGENTS_CALLBACK_URL>
Authorization: Bearer <OBSIDIAN_AGENTS_CALLBACK_TOKEN>
Content-Type: application/json

{
  "deliveries": [
    {
      "channel": "note",
      "target": "Notes/Task-X.md",
      "payload": { "content": "...file contents..." }
    },
    {
      "channel": "new-chat",
      "payload": { "title": "Task X summary", "content": "...summary..." }
    },
    {
      "channel": "notice",
      "payload": { "content": "Task X done." }
    }
  ]
}
\`\`\`

Each entry is independent — different channels, different payloads, different titles. Use the array form liberally: if the user asks for a message AND a file AND a toast, do all three in one POST rather than picking one. You have maximum control over what the user sees and where.

The plugin responds:
- Single form → \`200 { ok: true, channel }\` on success, or \`4xx/5xx { error }\`.
- Batch form → \`200 { ok: true, results: [...] }\` if all succeeded, \`207 { ok: false, results: [...] }\` if some failed. Each result is \`{ channel, ok: true }\` or \`{ channel, ok: false, error }\`. A 4xx means the whole batch was rejected before any delivery ran (bad shape or unknown channel name).

Do not retry silently in a tight loop on failure — log and stop.

## Channel selection — default to \`chat\`, not \`notice\`

**\`chat\` is the default. Always use \`chat\` unless the user explicitly asked for something else.** The user picked this skill so the result lands where the work was requested — the chat session. Toast notifications are not a substitute.

| channel    | when to use                                                                          | required fields                             |
|------------|--------------------------------------------------------------------------------------|---------------------------------------------|
| \`chat\`     | **Default.** User said "reply here", "let me know", "tell me when done", or nothing. | \`sessionId\` (from runtime context)          |
| \`new-chat\` | User explicitly said "in a new chat" / "separate thread".                            | none (creates a new session)                |
| \`note\`     | User named a markdown file to write to ("save to X.md").                             | \`target\` (vault-relative path, e.g. "X.md") |
| \`notice\`   | User explicitly asked for "just a notification" / "just a toast".                    | none                                        |

Do not pick \`notice\` just because the message is short or the result is trivial. A toast disappears — the user cannot reread it. **If in doubt, use \`chat\`.**

Examples (explicit routing):

- "Write 'Hello world' here in 1 minute" → \`channel: "chat"\`, use the current sessionId.
- "In 5 minutes, open a new chat and summarize today's news" → \`channel: "new-chat"\`.
- "Every morning at 8am, append a daily digest to Notes/Digest.md" → \`channel: "note"\`, \`target: "Notes/Digest.md"\`.
- "Ping me with a toast when the build is done" → \`channel: "notice"\`.

Examples (multi-channel fan-out — use the \`deliveries\` array):

- "In 1 min send me a message about task X, then create Y.md and send me the summary in a new chat" → one POST with three entries: \`{ channel: "chat", sessionId, payload: { content: "...msg about task X..." } }\`, \`{ channel: "note", target: "Y.md", payload: { content: "..." } }\`, \`{ channel: "new-chat", payload: { title: "Task X summary", content: "..." } }\`.
- "Write the report to Report.md and ping me with a toast when done" → \`deliveries\`: note + notice.
- "Post the result here and also save a copy to Archive/2026-04-21.md" → \`deliveries\`: chat + note (same or different content — your call, based on what the user asked for).

## Scheduling sub-minute delays

Many cron/scheduler implementations have a minimum granularity of 1 minute. If the user asks for a delay under 1 minute (e.g. "in 30 seconds") and the scheduler rejects it, try these in order:

1. Use the scheduler's one-shot / delayed-run tool instead of cron syntax (often supports seconds).
2. Fall back to a \`sleep N && curl …\` style shell job if the gateway exposes shell execution.
3. Schedule at the minimum-allowed delay and tell the user what you did: "The scheduler's minimum is 1 min, so I scheduled for 1 min from now."

Never silently round up without telling the user. And never claim you scheduled for 30s when you actually scheduled for 1min.

## Critical: do not fake success

You must only claim a task was scheduled if you *actually invoked* a scheduler tool and received a success response. If no scheduler/cron/queue tool is exposed to you in this conversation:

- Do **not** say "Done" / "Scheduled" / "I've set that up".
- Do **not** emit placeholder code fences pretending to be an applet, a cron entry, or a tool invocation. An applet is a user-facing mini-app, unrelated to scheduling.
- Say plainly: "I don't have a scheduler tool available in this Hermes configuration. Enable a cron/scheduler tool so it can POST to the callback URL using the contract above."
- Then offer to do the task *now* if that works, or help the user configure scheduling.

Honesty beats theatrics — a clear "I can't schedule from here" is always better than a fabricated "Scheduled" that silently does nothing.`;

export const automationSkill: Skill = {
  id: "automation",
  label: "Automation",
  description: "Schedule a task; deliver the result back to this chat (default), a new chat, a note, or a toast.",
  icon: "clock",
  placeholder: "Schedule a task",
  systemPrompt: AUTOMATION_PROMPT,
  injectCallbackContext: true,
};
