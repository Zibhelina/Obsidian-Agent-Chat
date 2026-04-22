import type { App } from "obsidian";
import type { DeliveryPayload, DeliveryRequest } from "../../types";
import type { ChatSession } from "../../types";

export interface DeliveryContext {
  app: App;
  // Read-only view of plugin state the channel needs. Kept narrow so channels
  // can't accidentally mutate sessions — they go through the provided hooks.
  getSession(id: string): ChatSession | undefined;
  appendAgentMessage(sessionId: string, payload: DeliveryPayload): void;
  createSessionWithMessage(name: string, payload: DeliveryPayload): ChatSession;
}

export interface DeliveryChannel {
  id: string;
  // Short sentence the delivery skill surfaces to the agent.
  describe: string;
  deliver(ctx: DeliveryContext, request: DeliveryRequest): Promise<void>;
}
