import { Component, setIcon } from "obsidian";
import type { ChatSession } from "../../types";
import { estimateSessionCost, formatUsd } from "../../lib/costEstimation";
import { formatTokenCount } from "../../tokenizer";

export class SessionStatsBar extends Component {
  containerEl: HTMLElement;
  private isOpen = false;

  constructor(container: HTMLElement) {
    super();
    this.containerEl = container.createDiv({ cls: "obsidian-agents-session-stats" });
    this.registerDomEvent(document, "click", (event) => {
      const target = event.target as Node | null;
      if (target && this.containerEl.contains(target)) return;
      this.close();
    });
  }

  render(session: ChatSession | null | undefined): void {
    this.containerEl.empty();
    if (!session || session.messages.length === 0) {
      this.containerEl.style.display = "none";
      return;
    }

    const estimate = estimateSessionCost(session);
    this.containerEl.style.display = "";
    this.containerEl.toggleClass("is-open", this.isOpen);

    const button = this.containerEl.createEl("button", {
      cls: "obsidian-agents-session-stats-button",
      attr: {
        type: "button",
        "aria-label": "Session info",
        title: "Session info",
        "aria-expanded": String(this.isOpen),
      },
    });
    setIcon(button, "info");
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.isOpen = !this.isOpen;
      this.render(session);
    });

    const popover = this.containerEl.createDiv({ cls: "obsidian-agents-session-stats-popover" });
    popover.createDiv({ cls: "obsidian-agents-session-stats-title", text: "Session info" });
    this.renderItem(popover, "Session tokens", formatTokenCount(estimate.totalTokens));
    this.renderItem(popover, "Estimated API cost", formatUsd(estimate.costUsd));
    if (estimate.unpricedTokens > 0) {
      this.renderItem(popover, "Unpriced", formatTokenCount(estimate.unpricedTokens));
    }
    if (estimate.unknownUsageCount > 0) {
      this.renderItem(popover, "Unknown usage", String(estimate.unknownUsageCount));
    }

    const note = popover.createDiv({
      cls: "obsidian-agents-session-stats-note",
      text: estimate.estimated ? "Hypothetical API cost estimate" : "Exact usage metadata",
    });
    if (estimate.unpricedModels.length > 0) {
      note.setAttribute("title", `Pricing unavailable: ${estimate.unpricedModels.join(", ")}`);
    }
  }

  private close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.containerEl.removeClass("is-open");
    const button = this.containerEl.querySelector(".obsidian-agents-session-stats-button");
    button?.setAttribute("aria-expanded", "false");
  }

  private renderItem(parent: HTMLElement, label: string, value: string): void {
    const item = parent.createDiv({ cls: "obsidian-agents-session-stats-item" });
    item.createSpan({ cls: "obsidian-agents-session-stats-label", text: label });
    item.createSpan({ cls: "obsidian-agents-session-stats-value", text: value });
  }
}
