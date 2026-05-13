import { Component, Notice, setIcon, TFile } from "obsidian";
import { Attachment, ChatMessage, LayoutBlock } from "../../types";
import { ThinkingTrace } from "./ThinkingTrace";
import { LayoutEngine } from "./LayoutEngine";
import { getSkill } from "../../features/commands";
import { ContextDebugModal } from "./ContextDebugModal";
import { parseMentionOccurrences } from "../../features/mentions";
import { pickMentionIcon, pickMentionTone } from "./LivePreviewEditor";

interface InlineMessageMention {
  label: string;
  path: string;
}

export class MessageBubble extends Component {
  private wrapper: HTMLElement;
  private bubble: HTMLElement;
  private message: ChatMessage;
  private plugin: any;
  private streamingEl: HTMLElement | null = null;
  private contentEl: HTMLElement | null = null;
  private trace: ThinkingTrace | null = null;
  private traceTickerId: number | null = null;
  private streamStart = Date.now();
  private isStreaming = false;

  constructor(container: HTMLElement, message: ChatMessage, plugin: any) {
    super();
    this.message = message;
    this.plugin = plugin;

    this.wrapper = container.createDiv({
      cls: `obsidian-agents-message-wrapper ${
        message.role === "user" ? "obsidian-agents-message-wrapper-user" : "obsidian-agents-message-wrapper-agent"
      }`,
      attr: {
        "data-message-id": message.id,
        "data-message-role": message.role,
      },
    });

    this.bubble = this.wrapper.createDiv({
      cls: `obsidian-agents-message-bubble ${
        message.role === "user" ? "obsidian-agents-message-bubble-user" : "obsidian-agents-message-bubble-agent"
      }`,
    });

    this.render();
  }

  private render(): void {
    // Full wrapper rebuild — prior attempts stacked duplicate trace panels and
    // action rows on every streaming token because we only cleared the bubble.
    this.wrapper.empty();
    this.trace = null;

    const isUser = this.message.role === "user";

    // Trace panel (above the content, for agent messages).
    if (!isUser) {
      const meta = this.message.metadata || {};
      const thinking = meta.thinking || "";
      const traceHost = this.wrapper.createDiv();
      this.trace = new ThinkingTrace(
        traceHost,
        meta,
        thinking,
        this.isStreaming,
        this.streamStart,
        this.message.id
      );
      this.addChild(this.trace);
    }

    // If slash skills were active on a user message, render a chip row
    // OUTSIDE the bubble (right above it) so the chips aren't crammed
    // inside the same pill as the text.
    if (isUser) {
      const skillIds = this.message.skillIds ?? [];
      if (skillIds.length > 0) {
        const chipRow = this.wrapper.createDiv({
          cls: "obsidian-agents-message-skill-chips",
        });
        for (const id of skillIds) {
          const skill = getSkill(id);
          const chip = chipRow.createSpan({
            cls: "obsidian-agents-message-skill-chip",
            attr: skill ? { title: skill.description } : {},
          });
          const iconEl = chip.createSpan({ cls: "obsidian-agents-message-skill-chip-icon" });
          setIcon(iconEl, skill?.icon ?? "sparkles");
          chip.createSpan({
            cls: "obsidian-agents-message-skill-chip-label",
            text: skill?.label ?? id.replace(/^\//, ""),
          });
        }
      }
    }

    // Recreate bubble
    this.bubble = this.wrapper.createDiv({
      cls: `obsidian-agents-message-bubble ${
        isUser ? "obsidian-agents-message-bubble-user" : "obsidian-agents-message-bubble-agent"
      }`,
    });

    // Tool calls are displayed in the Thinking drawer only (ChatGPT-style
    // Activity panel). Keeping them inline was double-surfacing the same
    // information, so the bubble now only carries the visible reply.
    this.contentEl = this.bubble.createDiv();

    if (isUser) {
      this.renderUserContent(this.contentEl, this.message.content);
    } else {
      const blocks: LayoutBlock[] = [];
      if (this.message.attachments) {
        for (const att of this.message.attachments) {
          blocks.push({
            type: att.type === "image" ? "image" : "applet",
            content: att.dataUrl || att.path,
            position: "below",
          });
        }
      }
      LayoutEngine.render(
        this.contentEl,
        this.message.content,
        blocks,
        this.plugin.app,
        this,
        ""
      );
    }

    // User attachments rendered ABOVE the bubble, outside of it.
    if (isUser && this.message.attachments?.length) {
      const imageAttachments = this.message.attachments
        .map((attachment) => ({ attachment, src: this.attachmentImageSrc(attachment) }))
        .filter((entry): entry is { attachment: Attachment; src: string } => Boolean(entry.src));
      const imageIds = new Set(imageAttachments.map((entry) => entry.attachment.id));
      const files = this.message.attachments.filter((a) => !imageIds.has(a.id));

      if (imageAttachments.length > 0) {
        const imgContainer = document.createElement("div");
        imgContainer.className = "obsidian-agents-user-attachments obsidian-agents-user-attachments-images";
        // Insert before the bubble so images sit above the text bubble
        this.wrapper.insertBefore(imgContainer, this.bubble);

        for (const { attachment: att, src } of imageAttachments) {
          const img = imgContainer.createEl("img", { cls: "obsidian-agents-user-attachment-img" });
          img.src = src;
          img.alt = att.name;
          img.style.cursor = "zoom-in";
          img.addEventListener("click", () => this.openLightbox(src, att.name));
        }
      }

      if (files.length > 0) {
        // Non-image files still sit inside/below the bubble text
        const fileContainer = this.bubble.createDiv({ cls: "obsidian-agents-user-attachments" });
        for (const att of files) {
          const fileEl = fileContainer.createDiv({ cls: "obsidian-agents-user-attachment-file" });
          fileEl.setText(`📄 ${att.name}`);
        }
      }
    }

    // Re-attach the streaming indicator if we're still streaming
    if (this.isStreaming) {
      this.streamingEl = this.bubble.createDiv({ cls: "obsidian-agents-streaming-indicator" });
      this.streamingEl.createDiv({ cls: "obsidian-agents-streaming-dot" });
      this.streamingEl.createDiv({ cls: "obsidian-agents-streaming-dot" });
      this.streamingEl.createDiv({ cls: "obsidian-agents-streaming-dot" });
    } else {
      this.streamingEl = null;
    }

    // Message action row (copy / reply) shown under the bubble on hover.
    // Hide during streaming so we don't clutter the placeholder.
    if (!this.isStreaming) {
      this.renderActions();
    }
  }

  private renderActions(): void {
    const row = this.wrapper.createDiv({ cls: "obsidian-agents-message-actions" });
    const copyBtn = row.createEl("button", {
      cls: "obsidian-agents-message-action-btn",
      attr: { "aria-label": "Copy" },
    });
    setIcon(copyBtn, "copy");
    copyBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(this.message.content);
        new Notice("Copied");
      } catch {
        new Notice("Copy failed");
      }
    });

    if (this.message.role === "agent") {
      const replyBtn = row.createEl("button", {
        cls: "obsidian-agents-message-action-btn",
        attr: { "aria-label": "Reply" },
      });
      setIcon(replyBtn, "reply");
      replyBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const sel = window.getSelection()?.toString().trim();
        const quote = sel || this.message.content;
        this.wrapper.dispatchEvent(
          new CustomEvent("obsidian-agents:reply", { detail: quote, bubbles: true })
        );
      });

      const branchBtn = row.createEl("button", {
        cls: "obsidian-agents-message-action-btn",
        attr: { "aria-label": "Branch in new chat" },
      });
      setIcon(branchBtn, "git-branch");
      branchBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.wrapper.dispatchEvent(
          new CustomEvent("obsidian-agents:branch", {
            detail: this.message.id,
            bubbles: true,
          })
        );
      });

      const contextDebug = this.message.metadata?.contextDebug;
      if (contextDebug) {
        const debugBtn = row.createEl("button", {
          cls: "obsidian-agents-message-action-btn",
          attr: { "aria-label": "Debug context", title: "Debug context" },
        });
        setIcon(debugBtn, "bug");
        debugBtn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const session = this.plugin.sessions?.find((s: { messages?: ChatMessage[] }) =>
            s.messages?.some((m) => m.id === this.message.id)
          );
          new ContextDebugModal(this.plugin.app, contextDebug, this.message, session).open();
        });
      }
    }
  }

  private renderUserContent(container: HTMLElement, content: string): void {
    const { content: displayContent, mentions } = this.replaceMentionTokens(content);
    LayoutEngine.render(
      container,
      displayContent.trim() || content,
      [],
      this.plugin.app,
      this,
      "",
      (textEl) => this.replaceMentionPlaceholders(textEl, mentions)
    );
  }

  private replaceMentionTokens(content: string): {
    content: string;
    mentions: InlineMessageMention[];
  } {
    const occurrences = parseMentionOccurrences(content).filter(
      (mention) => content[mention.tokenStart + 1] === "["
    );
    const mentions: InlineMessageMention[] = [];
    if (occurrences.length === 0) return { content, mentions };

    let displayContent = "";
    let cursor = 0;
    for (const mention of occurrences) {
      const index = mentions.length;
      displayContent += content.slice(cursor, mention.tokenStart);
      displayContent += this.mentionPlaceholder(index);
      cursor = mention.tokenEnd;
      mentions.push({
        label: mention.label || this.basename(mention.path),
        path: mention.path,
      });
    }
    displayContent += content.slice(cursor);
    return { content: displayContent.replace(/[ \t]{2,}/g, " "), mentions };
  }

  private mentionPlaceholder(index: number): string {
    return `@@OBSIDIAN_AGENTS_MENTION_${index}@@`;
  }

  private replaceMentionPlaceholders(
    root: HTMLElement,
    mentions: InlineMessageMention[]
  ): void {
    if (mentions.length === 0) return;

    const re = /@@OBSIDIAN_AGENTS_MENTION_(\d+)@@/g;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    let node = walker.nextNode();
    while (node) {
      textNodes.push(node as Text);
      node = walker.nextNode();
    }

    for (const textNode of textNodes) {
      const text = textNode.nodeValue ?? "";
      re.lastIndex = 0;
      if (!re.test(text)) continue;

      re.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let cursor = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(text)) !== null) {
        if (match.index > cursor) {
          frag.appendChild(document.createTextNode(text.slice(cursor, match.index)));
        }
        const mention = mentions[Number(match[1])];
        frag.appendChild(
          mention
            ? this.createInlineMentionChip(mention)
            : document.createTextNode(match[0])
        );
        cursor = match.index + match[0].length;
      }
      if (cursor < text.length) {
        frag.appendChild(document.createTextNode(text.slice(cursor)));
      }
      textNode.parentNode?.replaceChild(frag, textNode);
    }
  }

  private createInlineMentionChip(mention: InlineMessageMention): HTMLElement {
    const tone = pickMentionTone(mention.path);
    const found = Boolean(this.plugin.app?.vault.getAbstractFileByPath(mention.path));
    const chip = document.createElement("span");
    chip.className =
      `cm-obsidian-agents-mention-chip obsidian-agents-message-inline-mention-chip ${tone}` +
      (found ? "" : " cm-obsidian-agents-mention-chip-failed");
    chip.title = found
      ? mention.path
      : `Mention target not found: ${mention.path}`;
    chip.setAttribute("aria-label", mention.label);

    const iconEl = chip.createSpan({ cls: "cm-obsidian-agents-mention-chip-icon" });
    setIcon(iconEl, pickMentionIcon(mention.path));
    chip.createSpan({
      cls: "cm-obsidian-agents-mention-chip-label",
      text: mention.label,
    });
    return chip;
  }

  private basename(path: string): string {
    const normalized = path.replace(/\\/g, "/");
    return normalized.split("/").filter(Boolean).pop() || path;
  }

  private attachmentImageSrc(attachment: Attachment): string | null {
    if (attachment.type !== "image") return null;
    if (attachment.dataUrl) return attachment.dataUrl;
    if (!attachment.path) return null;
    if (/^(data:|https?:|file:|app:)/.test(attachment.path)) return attachment.path;
    const abstract = this.plugin.app.vault.getAbstractFileByPath(attachment.path);
    if (abstract instanceof TFile) {
      return this.plugin.app.vault.getResourcePath(abstract);
    }
    return null;
  }

  private openLightbox(src: string, name: string): void {
    const overlay = document.body.createDiv({ cls: "obsidian-agents-lightbox" });
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-label", `Preview ${name}`);
    const img = overlay.createEl("img", { cls: "obsidian-agents-lightbox-img" });
    img.src = src;
    img.alt = name;
    const close = overlay.createEl("button", {
      cls: "obsidian-agents-lightbox-close",
      attr: { "aria-label": "Close preview" },
    });
    setIcon(close, "x");

    const dismiss = () => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay || (e.target as HTMLElement).closest(".obsidian-agents-lightbox-close")) {
        dismiss();
      }
    });
    document.addEventListener("keydown", onKey);
  }

  update(message: ChatMessage): void {
    this.message = message;
    this.render();
  }

  getId(): string {
    return this.message.id;
  }

  getMessage(): ChatMessage {
    return this.message;
  }

  setMessage(msg: ChatMessage): void {
    this.message = msg;
    this.render();
  }

  setStreaming(isStreaming: boolean, knownStartTime?: number): void {
    const changed = this.isStreaming !== isStreaming;
    this.isStreaming = isStreaming;
    if (isStreaming) {
      // If a known start time is provided (e.g. when reconstructing after a
      // session switch) use it; otherwise fall back to the message timestamp
      // so the timer doesn't reset to zero on navigation.
      this.streamStart = knownStartTime ?? this.message.timestamp ?? Date.now();
      if (changed) {
        this.render();
        this.startTicker();
        this.wrapper.scrollIntoView({ behavior: "smooth", block: "end" });
      }
    } else {
      this.stopTicker();
      if (changed) this.render();
    }
  }

  private startTicker(): void {
    this.stopTicker();
    this.traceTickerId = window.setInterval(() => {
      this.trace?.tickElapsed();
    }, 500);
  }

  private stopTicker(): void {
    if (this.traceTickerId != null) {
      window.clearInterval(this.traceTickerId);
      this.traceTickerId = null;
    }
  }

  onunload(): void {
    this.stopTicker();
  }

  detach(): void {
    this.wrapper.remove();
  }

  updateMeta(): void {
    // Called after metadata/thinking updates — re-render trace panel
    this.render();
  }
}
