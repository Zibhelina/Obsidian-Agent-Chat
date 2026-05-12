import { Component } from "obsidian";
import { MessageList } from "./MessageList";

const PREVIEW_MAX_CHARS = 140;
const TOP_OFFSET_PX = 8;
// Lens magnification: dots within this vertical distance of the cursor
// scale up; falloff is Gaussian so it stays smooth as the cursor moves.
const LENS_RADIUS_PX = 60;
// The dot's intrinsic size in CSS matches the lens peak (see
// styles.css: `.obsidian-agents-chat-nav-dot` width/height). At rest dots
// are scaled DOWN to BASE_SCALE; under the cursor they scale UP to 1
// (no transform resampling), which keeps the largest dot pixel-crisp.
const BASE_SCALE = 0.42; // ~6px out of the 14px intrinsic dot
const PEAK_SCALE = 1.0;

interface DotEntry {
  id: string;
  text: string;
  el: HTMLElement;
}

/**
 * Vertical column of dots on the right edge of the chat — one per user
 * message. Highlights the dot closest to the current scroll position,
 * shows a hover preview of the prompt text, and click jumps that user
 * bubble to the top of the viewport.
 */
export class ChatNavigator extends Component {
  private host: HTMLElement;
  private rail: HTMLElement;
  private tooltip: HTMLElement;
  private dots: DotEntry[] = [];
  private activeId: string | null = null;
  private scrollEl: HTMLElement;
  private rafScheduled = false;
  // Cursor Y in viewport coords while the cursor is over the rail.
  // null means the lens is inactive and dots should be at base scale.
  private cursorY: number | null = null;
  private lensRafScheduled = false;

  constructor(
    private chatPanel: HTMLElement,
    private messageList: MessageList
  ) {
    super();
    this.scrollEl = messageList.containerEl;

    this.host = chatPanel.createDiv({ cls: "obsidian-agents-chat-nav" });
    this.rail = this.host.createDiv({ cls: "obsidian-agents-chat-nav-rail" });
    this.tooltip = this.host.createDiv({ cls: "obsidian-agents-chat-nav-tooltip" });
    this.tooltip.style.display = "none";

    messageList.onChange(() => this.rebuild());
    this.scrollEl.addEventListener("scroll", this.onScroll, { passive: true });
    window.addEventListener("resize", this.onScroll);

    this.rail.addEventListener("mousemove", this.onRailMouseMove);
    this.rail.addEventListener("mouseleave", this.onRailMouseLeave);

    this.rebuild();
  }

  onunload(): void {
    this.scrollEl.removeEventListener("scroll", this.onScroll);
    window.removeEventListener("resize", this.onScroll);
    this.rail.removeEventListener("mousemove", this.onRailMouseMove);
    this.rail.removeEventListener("mouseleave", this.onRailMouseLeave);
    this.host.remove();
  }

  private rebuild(): void {
    const stubs = this.messageList.getUserMessageStubs();
    this.rail.empty();
    this.dots = [];

    for (const stub of stubs) {
      const dot = this.rail.createDiv({
        cls: "obsidian-agents-chat-nav-dot",
        attr: { "data-id": stub.id },
      });
      const text = stub.text.trim();
      const preview =
        text.length > PREVIEW_MAX_CHARS
          ? text.slice(0, PREVIEW_MAX_CHARS).trimEnd() + "…"
          : text;

      dot.addEventListener("mouseenter", () => this.showTooltip(dot, preview));
      dot.addEventListener("mouseleave", () => this.hideTooltip());
      dot.addEventListener("click", (e) => {
        e.preventDefault();
        this.scrollToMessage(stub.id);
      });

      this.dots.push({ id: stub.id, text: preview, el: dot });
    }

    this.host.style.display = this.dots.length > 0 ? "" : "none";
    this.applyLens();
    this.updateActive();
  }

  private onScroll = (): void => {
    if (this.rafScheduled) return;
    this.rafScheduled = true;
    requestAnimationFrame(() => {
      this.rafScheduled = false;
      this.updateActive();
      if (this.cursorY !== null) this.applyLens();
    });
  };

  private onRailMouseMove = (e: MouseEvent): void => {
    this.cursorY = e.clientY;
    if (this.lensRafScheduled) return;
    this.lensRafScheduled = true;
    requestAnimationFrame(() => {
      this.lensRafScheduled = false;
      this.applyLens();
    });
  };

  private onRailMouseLeave = (): void => {
    this.cursorY = null;
    this.applyLens();
  };

  private applyLens(): void {
    const cy = this.cursorY;
    for (const d of this.dots) {
      if (cy === null) {
        d.el.style.transform = `scale(${BASE_SCALE})`;
        continue;
      }
      const rect = d.el.getBoundingClientRect();
      const dotCenter = rect.top + rect.height / 2;
      const dist = Math.abs(dotCenter - cy);
      // Gaussian falloff: peak at the cursor, ~base beyond LENS_RADIUS_PX.
      const t = Math.exp(-(dist * dist) / (2 * (LENS_RADIUS_PX / 2) ** 2));
      const scale = BASE_SCALE + (PEAK_SCALE - BASE_SCALE) * t;
      d.el.style.transform = `scale(${scale.toFixed(3)})`;
    }
  }

  private updateActive(): void {
    if (this.dots.length === 0) return;
    const viewportTop = this.scrollEl.getBoundingClientRect().top;
    const probe = viewportTop + TOP_OFFSET_PX + 24;

    let activeId = this.dots[0].id;
    for (const d of this.dots) {
      const wrapper = this.findWrapper(d.id);
      if (!wrapper) continue;
      const top = wrapper.getBoundingClientRect().top;
      if (top <= probe) {
        activeId = d.id;
      } else {
        break;
      }
    }

    if (activeId === this.activeId) return;
    this.activeId = activeId;
    for (const d of this.dots) {
      d.el.toggleClass("is-active", d.id === activeId);
    }
  }

  private scrollToMessage(id: string): void {
    const wrapper = this.findWrapper(id);
    if (!wrapper) return;
    const scrollRect = this.scrollEl.getBoundingClientRect();
    const wrapperRect = wrapper.getBoundingClientRect();
    const delta = wrapperRect.top - scrollRect.top - TOP_OFFSET_PX;
    this.scrollEl.scrollTo({
      top: this.scrollEl.scrollTop + delta,
      behavior: "smooth",
    });
  }

  private findWrapper(id: string): HTMLElement | null {
    return this.scrollEl.querySelector<HTMLElement>(
      `.obsidian-agents-message-wrapper[data-message-id="${CSS.escape(id)}"]`
    );
  }

  private showTooltip(dot: HTMLElement, text: string): void {
    if (!text) {
      this.hideTooltip();
      return;
    }
    this.tooltip.setText(text);
    this.tooltip.style.display = "";

    const hostRect = this.host.getBoundingClientRect();
    const dotRect = dot.getBoundingClientRect();
    const top = dotRect.top - hostRect.top + dotRect.height / 2;
    this.tooltip.style.top = `${top}px`;
  }

  private hideTooltip(): void {
    this.tooltip.style.display = "none";
  }
}
