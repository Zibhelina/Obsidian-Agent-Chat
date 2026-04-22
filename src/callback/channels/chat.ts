import type { DeliveryChannel } from "./types";

export const chatChannel: DeliveryChannel = {
  id: "chat",
  describe:
    'Append the result as a new agent message in the chat that scheduled the job. Default when the user says things like "reply here" or doesn\'t specify a destination.',
  async deliver(ctx, request) {
    if (!request.sessionId) {
      throw new Error("chat channel requires sessionId");
    }
    const session = ctx.getSession(request.sessionId);
    if (!session) {
      // Session was deleted — fall back to a new chat so the result isn't lost.
      ctx.createSessionWithMessage(
        request.payload.title || "Scheduled result",
        request.payload
      );
      return;
    }
    ctx.appendAgentMessage(request.sessionId, request.payload);
  },
};
