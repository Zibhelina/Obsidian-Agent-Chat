import type { DeliveryChannel } from "./types";

function sanitizePath(raw: string): string {
  // Strip leading slash and ".." segments so a malformed target can't escape
  // the vault. Obsidian's adapter is vault-scoped anyway, but the explicit
  // guard makes the intent obvious.
  const parts = raw
    .replace(/^\/+/, "")
    .split("/")
    .filter((p) => p && p !== "." && p !== "..");
  return parts.join("/");
}

export const noteChannel: DeliveryChannel = {
  id: "note",
  describe:
    'Append the result to a markdown file inside the Obsidian vault. Requires `target` (vault-relative path, e.g. "Daily/Summary.md"). Use when the user says things like "save the result to X.md" or "write it to a note".',
  async deliver(ctx, request) {
    const target = sanitizePath(request.target || "");
    if (!target) throw new Error("note channel requires a target path");

    const path = /\.[a-z0-9]+$/i.test(target) ? target : `${target}.md`;
    const adapter = ctx.app.vault.adapter;

    const stamp = new Date().toISOString();
    const meta = request.payload.metadata
      ? `<!-- ${JSON.stringify(request.payload.metadata)} -->\n`
      : "";
    const heading = request.payload.title
      ? `## ${request.payload.title} — ${stamp}\n`
      : `## ${stamp}\n`;
    const block = `\n\n${heading}${meta}${request.payload.content}\n`;

    // Ensure parent folders exist.
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (dir) {
      try {
        const exists = await adapter.exists(dir);
        if (!exists) await adapter.mkdir(dir);
      } catch {
        /* mkdir can throw on race or on iCloud — the write below will re-error */
      }
    }

    const exists = await adapter.exists(path);
    if (exists) {
      const existing = await adapter.read(path);
      await adapter.write(path, existing + block);
    } else {
      await adapter.write(path, block.trimStart());
    }
  },
};
