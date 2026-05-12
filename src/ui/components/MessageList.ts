import { Component } from "obsidian";
import { ChatMessage } from "../../types";
import { MessageBubble } from "./MessageBubble";

// Distance (in px) from the bottom within which we consider the user to
// be "following" the stream. If they're outside this window, we assume
// they scrolled up deliberately and leave their position alone.
const FOLLOW_THRESHOLD_PX = 120;

export class MessageList extends Component {
  containerEl: HTMLElement;
  private listEl: HTMLElement;
  private bubbles: MessageBubble[] = [];
  private changeListeners: (() => void)[] = [];
  // True when the viewport is close enough to the bottom that new content
  // should keep the user pinned there. Flips to false the moment they
  // scroll up out of that window during streaming, and stays false until
  // they scroll back down to the bottom.
  private followBottom = true;

  constructor(container: HTMLElement) {
    super();
    this.containerEl = container.createDiv({ cls: "obsidian-agents-message-list" });
    this.listEl = this.containerEl;

    // Update followBottom from the user's own scrolling. Without this,
    // scroll-to-bottom on every streaming token yanks the viewport back
    // down whenever the user tries to scroll up to read earlier content.
    this.containerEl.addEventListener(
      "scroll",
      () => {
        this.followBottom = this.isNearBottom();
      },
      { passive: true }
    );
  }

  private isNearBottom(): boolean {
    const el = this.containerEl;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD_PX;
  }

  addMessage(msg: ChatMessage, plugin: any): MessageBubble {
    const bubble = new MessageBubble(this.listEl, msg, plugin);
    this.addChild(bubble);
    this.bubbles.push(bubble);
    // Adding a message (user sent, or new agent bubble) is a strong signal
    // that the user wants to see fresh output — re-engage follow mode.
    this.followBottom = true;
    this.scrollToBottom();
    this.notifyChange();
    return bubble;
  }

  updateMessage(id: string, updater: (msg: ChatMessage) => ChatMessage, plugin: any): void {
    const bubble = this.bubbles.find((b) => b.getId() === id);
    if (!bubble) return;
    const prev = bubble.getMessage();
    const updated = updater(prev);
    bubble.setMessage(updated);
    if (prev.role === "user" && prev.content !== updated.content) {
      this.notifyChange();
    }
  }

  removeMessage(id: string): void {
    const idx = this.bubbles.findIndex((b) => b.getId() === id);
    if (idx === -1) return;
    const [bubble] = this.bubbles.splice(idx, 1);
    bubble.detach();
    this.removeChild(bubble);
    this.notifyChange();
  }

  clear(): void {
    this.listEl.empty();
    this.bubbles = [];
    this.followBottom = true;
    this.notifyChange();
  }

  /** Subscribe to message-set changes (add/remove/clear, plus user-content edits). */
  onChange(cb: () => void): void {
    this.changeListeners.push(cb);
  }

  private notifyChange(): void {
    for (const cb of this.changeListeners) cb();
  }

  /** Snapshot of user-message ids and their content text, in order. */
  getUserMessageStubs(): { id: string; text: string }[] {
    return this.bubbles
      .filter((b) => b.getMessage().role === "user")
      .map((b) => ({ id: b.getId(), text: b.getMessage().content }));
  }

  scrollToBottom(): void {
    this.containerEl.scrollTop = this.containerEl.scrollHeight;
  }

  /**
   * Called on every streaming token / tool-call update. Only actually
   * scrolls if the user is already at (or very near) the bottom, so a
   * deliberate scroll-up to read earlier content is respected.
   */
  scrollToBottomIfFollowing(): void {
    if (this.followBottom) {
      this.scrollToBottom();
    }
  }

  /** Set streaming state on a specific message bubble */
  setStreaming(id: string, isStreaming: boolean, knownStartTime?: number): void {
    const bubble = this.bubbles.find((b) => b.getId() === id);
    if (bubble) {
      bubble.setStreaming(isStreaming, knownStartTime);
    }
  }
}
