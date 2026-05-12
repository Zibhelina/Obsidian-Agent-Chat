import { App, Modal, Notice, setIcon } from "obsidian";
import type {
  ChatMessage,
  ChatSession,
  ContextDebugBlock,
  ContextDebugBlockType,
  ContextDebugSnapshot,
} from "../../types";
import {
  estimateInteractionCost,
  estimateSessionCost,
  formatUsd,
} from "../../lib/costEstimation";

type ContextDebugTab = "blocks" | "raw" | "stats";

export class ContextDebugModal extends Modal {
  private snapshot: ContextDebugSnapshot;
  private message?: ChatMessage;
  private session?: ChatSession;
  private activeTab: ContextDebugTab = "blocks";
  private searchQuery = "";

  constructor(app: App, snapshot: ContextDebugSnapshot, message?: ChatMessage, session?: ChatSession) {
    super(app);
    this.snapshot = snapshot;
    this.message = message;
    this.session = session;
  }

  onOpen(): void {
    this.modalEl.addClass("oa-context-debug-modal");
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    this.contentEl.empty();

    const shell = this.contentEl.createDiv({ cls: "oa-context-debug-shell" });
    const header = shell.createDiv({ cls: "oa-context-debug-header" });
    const heading = header.createDiv();
    heading.createDiv({ cls: "oa-context-debug-title", text: "Context Debugger" });
    heading.createDiv({
      cls: "oa-context-debug-meta",
      text: this.metadataLine(),
    });
    if (this.snapshot.warning) {
      heading.createDiv({
        cls: "oa-context-debug-warning",
        text: this.snapshot.warning,
      });
    }

    const copyBtn = header.createEl("button", {
      cls: "oa-context-debug-copy",
      attr: { "aria-label": "Copy raw JSON" },
    });
    setIcon(copyBtn, "copy");
    copyBtn.createSpan({ text: "Copy raw JSON" });
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(this.rawJson());
        new Notice("Context JSON copied");
      } catch {
        new Notice("Copy failed");
      }
    });

    const tabs = shell.createDiv({ cls: "oa-context-debug-tabs" });
    this.renderTab(tabs, "blocks", "Blocks");
    this.renderTab(tabs, "raw", "Raw JSON");
    this.renderTab(tabs, "stats", "Stats");

    const showSearch = this.activeTab === "blocks" || this.activeTab === "raw";
    if (showSearch) {
      const toolbar = shell.createDiv({ cls: "oa-context-debug-toolbar" });
      const searchWrap = toolbar.createDiv({ cls: "oa-context-debug-search-wrap" });
      setIcon(searchWrap.createSpan({ cls: "oa-context-debug-search-icon" }), "search");
      const input = searchWrap.createEl("input", {
        cls: "oa-context-debug-search",
        attr: {
          type: "search",
          placeholder: this.activeTab === "blocks" ? "Filter blocks" : "Search raw JSON",
          value: this.searchQuery,
        },
      });
      input.addEventListener("input", () => {
        this.searchQuery = input.value;
        this.render();
      });
      if (this.activeTab === "raw" && this.searchQuery.trim()) {
        toolbar.createDiv({
          cls: "oa-context-debug-search-count",
          text: `${this.countRawMatches(this.searchQuery)} matches`,
        });
      }
    }

    const body = shell.createDiv({ cls: "oa-context-debug-body" });
    if (this.activeTab === "blocks") this.renderBlocks(body);
    else if (this.activeTab === "raw") this.renderRaw(body);
    else this.renderStats(body);
  }

  private renderTab(parent: HTMLElement, tab: ContextDebugTab, label: string): void {
    const btn = parent.createEl("button", {
      cls: `oa-context-debug-tab${this.activeTab === tab ? " is-active" : ""}`,
      text: label,
      attr: { type: "button" },
    });
    btn.addEventListener("click", () => {
      this.activeTab = tab;
      this.render();
    });
  }

  private renderBlocks(parent: HTMLElement): void {
    const list = parent.createDiv({ cls: "oa-context-debug-block-list" });
    const blocks = this.filteredBlocks();
    if (blocks.length === 0) {
      list.createDiv({ cls: "oa-context-debug-empty", text: "No matching context blocks." });
      return;
    }

    for (const block of blocks) {
      const details = list.createEl("details", {
        cls: `oa-context-debug-block oa-context-debug-block-${block.type}`,
      });
      if (block.content.length < 900) details.open = true;

      const summary = details.createEl("summary", { cls: "oa-context-debug-block-summary" });
      const header = summary.createDiv({ cls: "oa-context-debug-block-header" });
      header.createSpan({
        cls: `oa-context-debug-chip oa-context-debug-chip-${block.type}`,
        text: this.labelForType(block.type),
      });
      header.createSpan({
        cls: "oa-context-debug-block-title",
        text: block.title || this.labelForType(block.type),
      });
      if (block.source) {
        header.createSpan({ cls: "oa-context-debug-block-source", text: block.source });
      }
      if (block.tokenEstimate != null) {
        header.createSpan({
          cls: "oa-context-debug-block-tokens",
          text: `${this.formatNumber(block.tokenEstimate)} est. tokens`,
        });
      }
      summary.createDiv({
        cls: "oa-context-debug-preview",
        text: this.preview(block.content),
      });

      const content = details.createEl("pre", { cls: "oa-context-debug-content" });
      content.setText(block.content);
    }
  }

  private renderRaw(parent: HTMLElement): void {
    const raw = parent.createEl("pre", { cls: "oa-context-debug-raw" });
    raw.setText(this.rawJson());
  }

  private renderStats(parent: HTMLElement): void {
    const stats = parent.createDiv({ cls: "oa-context-debug-stats" });
    const used = this.snapshot.estimatedTokens;
    const total = this.snapshot.contextWindow;
    const percent = this.snapshot.percentUsed ?? (used != null && total ? Math.round((used / total) * 100) : 0);
    const currentCost = estimateInteractionCost({
      message: this.message,
      snapshot: this.snapshot,
      sessionModel: this.session?.model,
    });
    const sessionCost = estimateSessionCost(this.session);

    const usage = stats.createDiv({ cls: "oa-context-debug-stat-card oa-context-debug-usage" });
    usage.createDiv({ cls: "oa-context-debug-stat-label", text: "Estimated context usage" });
    usage.createDiv({
      cls: "oa-context-debug-stat-value",
      text: `${used != null ? this.formatNumber(used) : "Unknown"}${
        total ? ` / ${this.formatNumber(total)}` : ""
      } tokens`,
    });
    const progress = usage.createDiv({ cls: "oa-context-debug-progress" });
    const fill = progress.createDiv({ cls: "oa-context-debug-progress-fill" });
    fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    usage.createDiv({
      cls: "oa-context-debug-stat-note",
      text: total ? `${percent}% of configured context window` : "No configured context window available",
    });

    const costGrid = stats.createDiv({ cls: "oa-context-debug-stat-grid oa-context-debug-cost-grid" });
    this.renderStat(
      costGrid,
      "Estimated cost — current interaction",
      formatUsd(currentCost.costUsd)
    );
    this.renderStat(
      costGrid,
      "Estimated cost — session total",
      formatUsd(sessionCost.costUsd)
    );
    this.renderStat(costGrid, "Current input tokens", this.formatOptionalNumber(currentCost.usage.inputTokens));
    this.renderStat(costGrid, "Current output tokens", this.formatOptionalNumber(currentCost.usage.outputTokens));
    this.renderStat(costGrid, "Current total tokens", this.formatOptionalNumber(currentCost.usage.totalTokens));
    this.renderStat(costGrid, "Session input tokens", this.formatNumber(sessionCost.inputTokens));
    this.renderStat(costGrid, "Session output tokens", this.formatNumber(sessionCost.outputTokens));
    this.renderStat(costGrid, "Session total tokens", this.formatNumber(sessionCost.totalTokens));

    const costNotes = this.costNotes(currentCost, sessionCost);
    if (costNotes.length > 0) {
      const note = costGrid.createDiv({ cls: "oa-context-debug-stat-wide" });
      note.setText(costNotes.join(" "));
    }

    const grid = stats.createDiv({ cls: "oa-context-debug-stat-grid" });
    this.renderStat(grid, "Blocks", this.formatNumber(this.snapshot.blocks.length));
    this.renderStat(grid, "Messages included", this.formatOptionalNumber(this.snapshot.messageCount));
    this.renderStat(grid, "Messages omitted", this.formatOptionalNumber(this.snapshot.omittedMessageCount));
    this.renderStat(grid, "Model", this.snapshot.model || "Unknown");
    this.renderStat(grid, "Provider", this.snapshot.provider || "Unknown");
    this.renderStat(grid, "Request source", this.requestSourceLabel());
    this.renderStat(grid, "API mode", this.snapshot.apiMode || "Unknown");
    this.renderStat(grid, "Session", this.snapshot.sessionId || "Unknown");
    this.renderStat(grid, "Hermes session", this.snapshot.hermesSessionId || "Unknown");
    this.renderStat(grid, "Timestamp", this.formatDate(this.snapshot.createdAt));
    this.renderStat(grid, "Compaction", this.compactionLabel());
    if (this.snapshot.compactionDetails) {
      grid.createDiv({
        cls: "oa-context-debug-stat-wide",
        text: this.snapshot.compactionDetails,
      });
    }
  }

  private costNotes(
    currentCost: ReturnType<typeof estimateInteractionCost>,
    sessionCost: ReturnType<typeof estimateSessionCost>
  ): string[] {
    const notes: string[] = ["Costs are hypothetical API estimates, not charges."];
    if (currentCost.estimated) {
      notes.push("Current interaction includes estimated token counts where exact usage is unavailable.");
    }
    if (currentCost.note) notes.push(currentCost.note);
    if (sessionCost.estimated) {
      notes.push("Session totals may mix exact and estimated token counts.");
    }
    if (sessionCost.unpricedTokens > 0) {
      notes.push(
        `${this.formatNumber(sessionCost.unpricedTokens)} session tokens are unpriced` +
          (sessionCost.unpricedModels.length > 0
            ? ` (${sessionCost.unpricedModels.join(", ")}).`
            : ".")
      );
    }
    if (sessionCost.unknownUsageCount > 0) {
      notes.push(`${sessionCost.unknownUsageCount} session interactions have unknown token usage.`);
    }
    return notes;
  }

  private renderStat(parent: HTMLElement, label: string, value: string): void {
    const item = parent.createDiv({ cls: "oa-context-debug-stat" });
    item.createDiv({ cls: "oa-context-debug-stat-label", text: label });
    item.createDiv({ cls: "oa-context-debug-stat-value", text: value });
  }

  private filteredBlocks(): ContextDebugBlock[] {
    const query = this.searchQuery.trim().toLowerCase();
    if (!query) return this.snapshot.blocks;
    return this.snapshot.blocks.filter((block) => {
      const haystack = [
        block.type,
        block.role,
        block.source,
        block.title,
        block.content,
        block.metadata ? this.safeJson(block.metadata) : "",
      ].join("\n").toLowerCase();
      return haystack.includes(query);
    });
  }

  private rawJson(): string {
    return this.safeJson(this.snapshot.rawRequest);
  }

  private safeJson(value: unknown): string {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  private countRawMatches(query: string): number {
    const q = query.trim();
    if (!q) return 0;
    const raw = this.rawJson().toLowerCase();
    const needle = q.toLowerCase();
    let count = 0;
    let index = raw.indexOf(needle);
    while (index !== -1) {
      count++;
      index = raw.indexOf(needle, index + needle.length);
    }
    return count;
  }

  private metadataLine(): string {
    const parts = [
      this.requestSourceLabel(),
      this.snapshot.model || "Unknown model",
      this.snapshot.provider || "Unknown provider",
      this.formatDate(this.snapshot.createdAt),
    ];
    if (this.snapshot.sessionId) parts.push(`session ${this.snapshot.sessionId}`);
    return parts.join(" | ");
  }

  private requestSourceLabel(): string {
    if (this.snapshot.requestSource === "hermes_model_request") return "Hermes model request";
    if (this.snapshot.requestSource === "plugin_gateway_request") return "Plugin gateway request";
    return "Context request";
  }

  private compactionLabel(): string {
    if (this.snapshot.compacted === true) return "Yes";
    if (this.snapshot.compacted === false) return "No";
    return "Unknown";
  }

  private labelForType(type: ContextDebugBlockType): string {
    if (type === "tool_schema") return "tool schema";
    return type.replace(/_/g, " ");
  }

  private preview(content: string): string {
    const text = content.replace(/\s+/g, " ").trim();
    return text.length > 220 ? `${text.slice(0, 220)}...` : text;
  }

  private formatNumber(value: number): string {
    return new Intl.NumberFormat().format(value);
  }

  private formatOptionalNumber(value: number | undefined): string {
    return value == null ? "Unknown" : this.formatNumber(value);
  }

  private formatDate(value: number): string {
    return new Date(value).toLocaleString();
  }
}
