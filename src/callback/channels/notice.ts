import { Notice } from "obsidian";
import type { DeliveryChannel } from "./types";

export const noticeChannel: DeliveryChannel = {
  id: "notice",
  describe:
    'Show the result as a transient Obsidian toast notification — fire-and-forget, no chat message, no file. Use when the user says things like "just a notification" or "let me know when it\'s done".',
  async deliver(_ctx, request) {
    const text = request.payload.title
      ? `${request.payload.title}\n${request.payload.content}`
      : request.payload.content;
    // 10s default — long enough to read, short enough to not nag.
    new Notice(text, 10_000);
  },
};
