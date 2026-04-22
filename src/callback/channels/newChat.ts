import type { DeliveryChannel } from "./types";

export const newChatChannel: DeliveryChannel = {
  id: "new-chat",
  describe:
    'Create a new chat session and post the result there. Use when the user says things like "reply in a new chat" or "open a separate thread".',
  async deliver(ctx, request) {
    const name = request.payload.title || "Scheduled result";
    ctx.createSessionWithMessage(name, request.payload);
  },
};
