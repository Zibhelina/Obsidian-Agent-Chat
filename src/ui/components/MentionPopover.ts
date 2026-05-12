import { App, setIcon } from "obsidian";
import { MentionItem } from "../../types";
import { searchVaultFiles } from "../../lib/vault";
import { formatInlineMention } from "../../features/mentions";

const MAX_VISIBLE = 30;

/**
 * Minimal textarea-like surface. Lets MentionPopover drive both a native
 * HTMLTextAreaElement and a CM6-backed live-preview editor.
 */
export interface TextInputLike {
  getValue(): string;
  setValue(value: string): void;
  getCursor(): number;
  setCursor(pos: number): void;
  replaceRange(from: number, to: number, insert: string): void;
  focus(): void;
  addEventListener(
    type: "input" | "click" | "keyup" | "keydown",
    handler: (e: any) => void,
    opts?: boolean
  ): void;
  removeEventListener(
    type: "input" | "click" | "keyup" | "keydown",
    handler: (e: any) => void,
    opts?: boolean
  ): void;
}

export class MentionPopover {
  private el: HTMLElement | null = null;
  private anchorEl: HTMLElement | null = null;
  private app: App;
  private textarea: TextInputLike | null = null;
  private query = "";
  private startIndex = -1;
  private items: MentionItem[] = [];
  private selectedIndex = 0;
  private active = false;
  private boundClickOutside: (e: MouseEvent) => void;

  constructor(app: App) {
    this.app = app;
    this.boundClickOutside = this.handleClickOutside.bind(this);
  }

  mount(parent: HTMLElement, textarea: TextInputLike): void {
    this.detach();
    this.textarea = textarea;
    this.anchorEl = parent;

    // Mount into document body with fixed positioning so overflow:hidden
    // ancestors cannot clip the popover.
    this.el = document.body.createDiv({
      cls: "obsidian-agents-mention-popover obsidian-agents-mention-popover-fixed",
    });
    this.el.style.display = "none";

    textarea.addEventListener("input", this.handleInput);
    textarea.addEventListener("click", this.handleInput);
    textarea.addEventListener("keyup", this.handleInput);
    textarea.addEventListener("keydown", this.handleKeydown, true);
    document.addEventListener("mousedown", this.boundClickOutside);
  }

  /** Called by Composer every time the editor content changes (docChanged). */
  onEditorChange(): void {
    this.handleInput();
  }

  detach(): void {
    if (this.textarea) {
      this.textarea.removeEventListener("input", this.handleInput);
      this.textarea.removeEventListener("click", this.handleInput);
      this.textarea.removeEventListener("keyup", this.handleInput);
      this.textarea.removeEventListener("keydown", this.handleKeydown, true);
      this.textarea = null;
    }
    document.removeEventListener("mousedown", this.boundClickOutside);
    if (this.el) {
      this.el.remove();
      this.el = null;
    }
    this.anchorEl = null;
    this.active = false;
  }

  isActive(): boolean {
    return this.active;
  }

  private handleInput = () => {
    if (!this.textarea) return;
    const cursor = this.textarea.getCursor();
    const text = this.textarea.getValue();
    const beforeCursor = text.slice(0, cursor);

    const atIndex = beforeCursor.lastIndexOf("@");
    if (atIndex === -1) {
      this.hide();
      return;
    }

    const prevChar = atIndex === 0 ? "" : beforeCursor[atIndex - 1];
    if (prevChar && !/\s/.test(prevChar)) {
      this.hide();
      return;
    }

    const afterAt = beforeCursor.slice(atIndex + 1);
    if (/\n/.test(afterAt)) {
      this.hide();
      return;
    }
    if (afterAt.length > 80) {
      this.hide();
      return;
    }

    this.query = afterAt;
    this.startIndex = atIndex;
    this.items = searchVaultFiles(this.app, this.query);
    this.selectedIndex = 0;
    this.renderItems();
  };

  private handleKeydown = (evt: KeyboardEvent) => {
    if (!this.active || this.items.length === 0) return;

    if (evt.key === "ArrowDown") {
      evt.preventDefault();
      evt.stopPropagation();
      this.selectedIndex = (this.selectedIndex + 1) % this.items.length;
      this.updateSelection();
    } else if (evt.key === "ArrowUp") {
      evt.preventDefault();
      evt.stopPropagation();
      this.selectedIndex = (this.selectedIndex - 1 + this.items.length) % this.items.length;
      this.updateSelection();
    } else if (evt.key === "Enter" || evt.key === "Tab") {
      evt.preventDefault();
      evt.stopPropagation();
      this.selectItem(this.items[this.selectedIndex]);
    } else if (evt.key === "Escape") {
      evt.preventDefault();
      evt.stopPropagation();
      this.hide();
      this.textarea?.focus();
    }
  };

  private handleClickOutside = (e: MouseEvent) => {
    if (!this.active || !this.el) return;
    const target = e.target as HTMLElement;
    if (this.el.contains(target)) return;
    if (target.closest(".obsidian-agents-composer")) return;
    this.hide();
  };

  private positionPopover(): void {
    if (!this.el || !this.anchorEl) return;
    const rect = this.anchorEl.getBoundingClientRect();
    this.el.style.left = `${rect.left}px`;
    this.el.style.width = `${rect.width}px`;
    // Default to 280 for initial placement; will adjust on scroll/resize
    const estimatedHeight = 280;
    const spaceAbove = rect.top - 8;
    if (spaceAbove >= 80) {
      this.el.style.top = `${rect.top - estimatedHeight - 6}px`;
    } else {
      this.el.style.top = `${rect.bottom + 6}px`;
    }
    this.el.style.bottom = "auto";
  }

  private renderItems(): void {
    if (!this.el) return;
    this.el.empty();
    if (this.items.length === 0) {
      this.hide();
      return;
    }

    this.active = true;
    this.el.style.display = "block";
    this.positionPopover();

    const visible = this.items.slice(0, MAX_VISIBLE);

    for (let i = 0; i < visible.length; i++) {
      const item = visible[i];
      const row = this.el.createDiv({
        cls: "obsidian-agents-mention-item" + (i === this.selectedIndex ? " selected" : ""),
      });
      row.setAttribute("data-index", String(i));

      const icon = row.createSpan({ cls: "obsidian-agents-mention-icon" });
      setIcon(icon, item.type === "folder" ? "folder" : "file-text");

      const text = row.createDiv({ cls: "obsidian-agents-mention-text" });
      text.createDiv({ cls: "obsidian-agents-mention-name", text: item.displayName });
      if (item.path && item.path !== item.displayName) {
        text.createDiv({ cls: "obsidian-agents-mention-path", text: item.path });
      }

      row.addEventListener("mouseenter", () => {
        this.selectedIndex = i;
        this.updateSelection();
      });
      // mousedown + preventDefault keeps editor focus while selecting
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.selectItem(item);
      });
    }
  }

  private updateSelection(): void {
    if (!this.el) return;
    const rows = this.el.querySelectorAll<HTMLElement>(".obsidian-agents-mention-item");
    rows.forEach((row) => {
      const idx = Number(row.getAttribute("data-index"));
      if (idx === this.selectedIndex) {
        row.addClass("selected");
        row.scrollIntoView({ block: "nearest" });
      } else {
        row.removeClass("selected");
      }
    });
  }

  private selectItem(item: MentionItem): void {
    if (!this.textarea || this.startIndex < 0) return;

    // Replace the typed @query with canonical inline mention markup. The
    // CodeMirror live-preview layer renders this plain text as a compact chip,
    // while the stored editor value remains parseable by parseMentions().
    const cursor = this.textarea.getCursor();
    const capturedStart = this.startIndex;
    const nextChar = this.textarea.getValue()[cursor] ?? "";
    const trailingSpace = nextChar && /\s/.test(nextChar) ? "" : " ";
    const token = `${formatInlineMention(item.displayName, item.path)}${trailingSpace}`;
    this.hide(); // clear state BEFORE replaceRange triggers re-entrancy
    this.textarea.replaceRange(capturedStart, cursor, token);
    this.textarea.setCursor(capturedStart + token.length);
    this.textarea.focus();
  }

  private hide(): void {
    if (this.el) {
      this.el.style.display = "none";
      this.el.empty();
    }
    this.active = false;
    this.query = "";
    this.items = [];
    this.startIndex = -1;
  }
}
