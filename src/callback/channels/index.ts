import type { DeliveryChannel } from "./types";
import { chatChannel } from "./chat";
import { newChatChannel } from "./newChat";
import { noteChannel } from "./note";
import { noticeChannel } from "./notice";

export const BUILT_IN_CHANNELS: DeliveryChannel[] = [
  chatChannel,
  newChatChannel,
  noteChannel,
  noticeChannel,
];

export class ChannelRegistry {
  private channels = new Map<string, DeliveryChannel>();

  constructor(initial: DeliveryChannel[] = BUILT_IN_CHANNELS) {
    for (const c of initial) this.register(c);
  }

  register(channel: DeliveryChannel): void {
    this.channels.set(channel.id, channel);
  }

  get(id: string): DeliveryChannel | undefined {
    return this.channels.get(id);
  }

  list(): DeliveryChannel[] {
    return Array.from(this.channels.values());
  }
}

export type { DeliveryChannel, DeliveryContext } from "./types";
