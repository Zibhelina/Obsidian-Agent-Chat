import { Component, Notice, setIcon } from "obsidian";
import {
  listAuthenticatedProviders,
  getProvider,
  getProviderModels,
  filterProviderModels,
  type AuthenticatedProvider,
  type AuthInfo,
  type ProviderModelEntry,
} from "../../lib/hermesProviders";
import {
  readActiveModel,
  writeActiveModel,
  hermesConfigExists,
} from "../../lib/hermesConfig";

export type EffortLevel = "minimal" | "low" | "medium" | "high";

export interface ModelPickerHandlers {
  /** Called after a model/provider switch lands so callers can rerender. */
  onChanged?: () => void;
  getEffort: () => EffortLevel;
  setEffort: (effort: EffortLevel) => void | Promise<void>;
}

const ALL_EFFORTS: EffortLevel[] = ["minimal", "low", "medium", "high"];
const EFFORT_LABELS: Record<EffortLevel, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
};

/**
 * Composer toggle — text label with a chevron, next to the send button.
 *
 * Click opens a small inline card with two rows:
 *   - Model: shows the active provider + model. Clicking opens a centered
 *     modal that mirrors `hermes model` — pick a provider (from those that
 *     already have credentials), pick an auth method if more than one is
 *     available, then pick a curated model. Selection writes
 *     `model.provider` / `model.default` / `model.base_url` to
 *     ~/.hermes/config.yaml. The Hermes gateway re-reads that file on every
 *     chat completion (see gateway/run.py:_resolve_runtime_agent_kwargs), so
 *     the change applies to the next message — no gateway restart needed.
 *   - Reasoning effort: hover/click to flip a sub-card with the four
 *     standard OpenAI-compat levels (minimal/low/medium/high). Selection
 *     writes `agent.reasoning_effort` to ~/.hermes/config.yaml immediately
 *     and saves the plugin setting so the next message uses the same value.
 */
export class ModelPicker extends Component {
  containerEl: HTMLElement;
  private buttonEl: HTMLButtonElement;
  private labelEl: HTMLSpanElement;
  private cardEl: HTMLElement | null = null;
  private effortSubCardEl: HTMLElement | null = null;
  private modalEl: HTMLElement | null = null;
  private handlers: ModelPickerHandlers;
  private hideEffortTimer: number | null = null;

  // Modal navigation state.
  private modalSelectedProviderSlug: string | null = null;
  private modalSelectedAuthId: string | null = null;
  private modalSearchQuery = "";
  private modalSearchInput: HTMLInputElement | null = null;

  constructor(parent: HTMLElement, handlers: ModelPickerHandlers) {
    super();
    this.handlers = handlers;
    this.containerEl = parent.createDiv({ cls: "obsidian-agents-model-picker" });

    this.buttonEl = this.containerEl.createEl("button", {
      cls: "obsidian-agents-model-picker-btn",
      attr: { "aria-label": "Model and reasoning effort" },
    });
    this.labelEl = this.buttonEl.createSpan({ cls: "obsidian-agents-model-picker-label" });
    const caret = this.buttonEl.createSpan({ cls: "obsidian-agents-model-picker-caret" });
    setIcon(caret, "chevron-down");
    this.refreshButton();

    this.buttonEl.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleCard();
    });

    document.addEventListener("click", this.onDocClick);
  }

  private onDocClick = (e: MouseEvent): void => {
    if (this.modalEl) return; // Modal handles its own backdrop click.
    if (!this.cardEl) return;
    const target = e.target as Node;
    if (
      this.containerEl.contains(target) ||
      this.cardEl.contains(target) ||
      (this.effortSubCardEl && this.effortSubCardEl.contains(target))
    ) {
      return;
    }
    this.hideCard();
  };

  refreshButton(): void {
    const active = readActiveModel();
    const modelLabel = this.formatModelDisplay(active.provider, active.model);
    const effortLabel = EFFORT_LABELS[this.handlers.getEffort()];
    this.labelEl.setText(`${modelLabel} · ${effortLabel}`);
  }

  /**
   * Display name for the active model. Prefers the catalog's friendly name
   * when available; otherwise strips the leading provider prefix from a
   * slug like "anthropic/claude-opus-4-7" so the toggle stays readable.
   */
  private formatModelDisplay(
    providerSlug: string | null,
    modelId: string | null
  ): string {
    if (!modelId) return "auto";
    const provider = providerSlug ? getProvider(providerSlug) : null;
    if (provider) {
      const entries = getProviderModels(provider.slug);
      const match = entries.find((m) => m.id === modelId);
      if (match && match.name && match.name !== match.id) return match.name;
    }
    const slash = modelId.indexOf("/");
    return slash >= 0 ? modelId.slice(slash + 1) : modelId;
  }

  private toggleCard(): void {
    if (this.cardEl) this.hideCard();
    else this.showCard();
  }

  private showCard(): void {
    this.cardEl = this.containerEl.createDiv({ cls: "obsidian-agents-model-card" });
    this.renderCard();
    this.containerEl.addClass("obsidian-agents-model-picker-open");
  }

  private hideCard(): void {
    this.clearEffortHideTimer();
    if (this.effortSubCardEl) {
      this.effortSubCardEl.remove();
      this.effortSubCardEl = null;
    }
    if (this.cardEl) {
      this.cardEl.remove();
      this.cardEl = null;
    }
    this.containerEl.removeClass("obsidian-agents-model-picker-open");
  }

  private renderCard(): void {
    if (!this.cardEl) return;
    this.cardEl.empty();

    const active = readActiveModel();
    const activeProvider = active.provider ? getProvider(active.provider) : null;
    const activeProviderName = activeProvider?.name ?? active.provider ?? "—";
    const activeModelName = active.model ?? "—";

    // --- Model row ---
    const modelRow = this.cardEl.createDiv({
      cls: "obsidian-agents-model-card-row",
      attr: { "data-row": "model" },
    });
    const modelIcon = modelRow.createSpan({ cls: "obsidian-agents-model-card-row-icon" });
    setIcon(modelIcon, "cpu");
    const modelMain = modelRow.createDiv({ cls: "obsidian-agents-model-card-row-main" });
    modelMain.createDiv({
      cls: "obsidian-agents-model-card-row-title",
      text: "Model",
    });
    modelMain.createDiv({
      cls: "obsidian-agents-model-card-row-value",
      text: `${activeProviderName} · ${activeModelName}`,
    });
    modelRow.addEventListener("click", (e) => {
      e.stopPropagation();
      this.openModal();
    });

    // --- Effort row ---
    const effortRow = this.cardEl.createDiv({
      cls: "obsidian-agents-model-card-row",
      attr: { "data-row": "effort" },
    });
    const effortIcon = effortRow.createSpan({ cls: "obsidian-agents-model-card-row-icon" });
    setIcon(effortIcon, "zap");
    const effortMain = effortRow.createDiv({ cls: "obsidian-agents-model-card-row-main" });
    effortMain.createDiv({
      cls: "obsidian-agents-model-card-row-title",
      text: "Reasoning effort",
    });
    const currentEffort = this.handlers.getEffort();
    effortMain.createDiv({
      cls: "obsidian-agents-model-card-row-value",
      text: EFFORT_LABELS[currentEffort],
    });
    const effortCaret = effortRow.createSpan({ cls: "obsidian-agents-model-card-row-caret" });
    setIcon(effortCaret, "chevron-right");

    effortRow.addEventListener("mouseenter", () => this.openEffortSubCard(effortRow));
    effortRow.addEventListener("click", (e) => {
      e.stopPropagation();
      this.openEffortSubCard(effortRow);
    });
  }

  // --- Effort sub-card -----------------------------------------------------

  private clearEffortHideTimer(): void {
    if (this.hideEffortTimer != null) {
      window.clearTimeout(this.hideEffortTimer);
      this.hideEffortTimer = null;
    }
  }

  private openEffortSubCard(rowEl: HTMLElement): void {
    this.clearEffortHideTimer();
    if (this.effortSubCardEl) return;
    if (!this.cardEl) return;
    this.effortSubCardEl = this.cardEl.createDiv({
      cls: "obsidian-agents-model-subcard obsidian-agents-model-subcard-effort",
    });
    const current = this.handlers.getEffort();
    for (const effort of ALL_EFFORTS) {
      const item = this.effortSubCardEl.createDiv({
        cls:
          "obsidian-agents-model-subcard-item" +
          (effort === current ? " selected" : ""),
      });
      item.createSpan({
        cls: "obsidian-agents-model-subcard-item-label",
        text: EFFORT_LABELS[effort],
      });
      item.addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          await this.handlers.setEffort(effort);
        } catch {
          // Handler already surfaced a Notice and rolled back its state.
        } finally {
          this.refreshAfterChange();
        }
      });
    }
    this.effortSubCardEl.addEventListener("mouseleave", () =>
      this.scheduleEffortHide()
    );
    this.effortSubCardEl.addEventListener("mouseenter", () =>
      this.clearEffortHideTimer()
    );
    rowEl.addEventListener(
      "mouseleave",
      () => this.scheduleEffortHide(),
      { once: true }
    );
  }

  private scheduleEffortHide(): void {
    this.clearEffortHideTimer();
    this.hideEffortTimer = window.setTimeout(() => {
      if (this.effortSubCardEl) {
        this.effortSubCardEl.remove();
        this.effortSubCardEl = null;
      }
      this.hideEffortTimer = null;
    }, 180);
  }

  // --- Centered model selection modal --------------------------------------

  private openModal(): void {
    this.hideCard();
    if (this.modalEl) return;

    // Initialize modal state from whatever's active.
    const active = readActiveModel();
    this.modalSelectedProviderSlug = active.provider;
    this.modalSelectedAuthId = null;
    this.modalSearchQuery = "";

    this.modalEl = document.body.createDiv({
      cls: "obsidian-agents-model-modal-backdrop",
    });
    const dialog = this.modalEl.createDiv({
      cls: "obsidian-agents-model-modal",
      attr: { role: "dialog", "aria-label": "Select model" },
    });
    this.renderModal(dialog);

    this.modalEl.addEventListener("click", (e) => {
      if (e.target === this.modalEl) this.closeModal();
    });
    document.addEventListener("keydown", this.onModalKeydown);
  }

  private onModalKeydown = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && this.modalEl) {
      e.preventDefault();
      this.closeModal();
    }
  };

  private closeModal(): void {
    if (this.modalEl) {
      this.modalEl.remove();
      this.modalEl = null;
    }
    document.removeEventListener("keydown", this.onModalKeydown);
  }

  private renderModal(dialog: HTMLElement): void {
    dialog.empty();

    // Header.
    const header = dialog.createDiv({ cls: "obsidian-agents-model-modal-header" });
    header.createDiv({
      cls: "obsidian-agents-model-modal-title",
      text: "Select model",
    });
    const close = header.createEl("button", {
      cls: "obsidian-agents-model-modal-close",
      attr: { "aria-label": "Close" },
    });
    setIcon(close, "x");
    close.addEventListener("click", () => this.closeModal());

    if (!hermesConfigExists()) {
      const warn = dialog.createDiv({ cls: "obsidian-agents-model-modal-warn" });
      warn.setText(
        "No Hermes config found. Run `hermes setup` once, then come back."
      );
      return;
    }

    const authProviders = listAuthenticatedProviders();
    if (authProviders.length === 0) {
      const warn = dialog.createDiv({ cls: "obsidian-agents-model-modal-warn" });
      warn.setText(
        "No authenticated providers detected. Run `hermes login <provider>` " +
          "(or set the relevant API key in ~/.hermes/.env), then reopen this picker."
      );
      return;
    }

    const body = dialog.createDiv({ cls: "obsidian-agents-model-modal-body" });

    // Three columns: providers / auth methods / models.
    const providerCol = body.createDiv({
      cls: "obsidian-agents-model-modal-col obsidian-agents-model-modal-col-providers",
    });
    const authCol = body.createDiv({
      cls: "obsidian-agents-model-modal-col obsidian-agents-model-modal-col-auth",
    });
    const modelCol = body.createDiv({
      cls: "obsidian-agents-model-modal-col obsidian-agents-model-modal-col-models",
    });

    providerCol.createDiv({
      cls: "obsidian-agents-model-modal-col-heading",
      text: "Provider",
    });

    let activeProvider: AuthenticatedProvider | undefined =
      authProviders.find((p) => p.slug === this.modalSelectedProviderSlug) ??
      authProviders[0];
    this.modalSelectedProviderSlug = activeProvider?.slug ?? null;

    for (const p of authProviders) {
      const row = providerCol.createDiv({
        cls:
          "obsidian-agents-model-modal-item" +
          (p.slug === this.modalSelectedProviderSlug ? " selected" : ""),
      });
      row.createSpan({
        cls: "obsidian-agents-model-modal-item-label",
        text: p.name,
      });
      row.createSpan({
        cls: "obsidian-agents-model-modal-item-meta",
        text:
          p.authMethods.length === 1
            ? p.authMethods[0].label
            : `${p.authMethods.length} auth methods`,
      });
      row.addEventListener("click", () => {
        this.modalSelectedProviderSlug = p.slug;
        this.modalSelectedAuthId = null;
        // A search filter from the previous provider almost certainly won't
        // match the new provider's models. Clear it on switch.
        this.modalSearchQuery = "";
        this.renderModal(dialog);
      });
    }

    // Auth column.
    if (activeProvider) {
      authCol.createDiv({
        cls: "obsidian-agents-model-modal-col-heading",
        text: "Authentication",
      });
      // Default to the first method.
      if (
        !this.modalSelectedAuthId ||
        !activeProvider.authMethods.some((a) => a.id === this.modalSelectedAuthId)
      ) {
        this.modalSelectedAuthId = activeProvider.authMethods[0]?.id ?? null;
      }
      for (const m of activeProvider.authMethods) {
        this.renderAuthRow(authCol, m, dialog);
      }
    }

    // Model column — heading + search + scrollable list.
    if (activeProvider) {
      this.renderModelColumn(modelCol, activeProvider);
    }
  }

  private renderModelColumn(
    container: HTMLElement,
    activeProvider: AuthenticatedProvider
  ): void {
    container.createDiv({
      cls: "obsidian-agents-model-modal-col-heading",
      text: "Model",
    });

    // Search input. Pulled out so we can keep focus + caret position across
    // re-renders triggered by typing.
    const searchWrap = container.createDiv({
      cls: "obsidian-agents-model-modal-search",
    });
    const searchIcon = searchWrap.createSpan({
      cls: "obsidian-agents-model-modal-search-icon",
    });
    setIcon(searchIcon, "search");
    this.modalSearchInput = searchWrap.createEl("input", {
      type: "text",
      attr: { placeholder: "Search models…" },
    });
    this.modalSearchInput.value = this.modalSearchQuery;
    this.modalSearchInput.addEventListener("input", () => {
      this.modalSearchQuery = this.modalSearchInput!.value;
      this.renderModelList(listEl, activeProvider);
    });
    // Keep keyboard out of the way of the modal-level Escape handler. Without
    // this stopPropagation, typing "e" in the search would try to close the
    // modal via the document keydown listener on some keyboards.
    this.modalSearchInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (this.modalSearchQuery) {
          // First Escape clears the query; second Escape closes the modal.
          e.preventDefault();
          e.stopPropagation();
          this.modalSearchQuery = "";
          this.modalSearchInput!.value = "";
          this.renderModelList(listEl, activeProvider);
        }
      }
    });

    const listEl = container.createDiv({
      cls: "obsidian-agents-model-modal-list",
    });
    this.renderModelList(listEl, activeProvider);

    // Auto-focus search when the modal opens with a many-model provider so
    // typing immediately filters. Defer to next tick — input element isn't
    // in the DOM until layout settles.
    setTimeout(() => this.modalSearchInput?.focus(), 0);
  }

  private renderModelList(
    listEl: HTMLElement,
    activeProvider: AuthenticatedProvider
  ): void {
    listEl.empty();
    const all = getProviderModels(activeProvider.slug);
    const filtered = filterProviderModels(all, this.modalSearchQuery, 200);

    if (filtered.length === 0) {
      const empty = listEl.createDiv({
        cls: "obsidian-agents-model-modal-empty",
      });
      empty.setText("No models match that search.");
      return;
    }

    const active = readActiveModel();
    const isActiveProvider = active.provider === activeProvider.slug;

    for (const m of filtered) {
      const row = listEl.createDiv({
        cls:
          "obsidian-agents-model-modal-item" +
          (isActiveProvider && active.model === m.id ? " selected" : ""),
      });
      row.createSpan({
        cls: "obsidian-agents-model-modal-item-label",
        text: m.name,
      });
      // ID line (smaller, muted) only when it differs from the friendly name.
      if (m.id !== m.name) {
        row.createSpan({
          cls: "obsidian-agents-model-modal-item-meta",
          text: m.id,
        });
      }
      if (m.badges.length > 0) {
        const badgeRow = row.createDiv({
          cls: "obsidian-agents-model-modal-item-badges",
        });
        for (const b of m.badges) {
          badgeRow.createSpan({
            cls: `obsidian-agents-model-modal-badge obsidian-agents-model-modal-badge-${b}`,
            text: b,
          });
        }
      }
      row.addEventListener("click", () => this.applySelection(m.id));
    }

    // Show a "showing N of M" footer so the user knows when the catalog is
    // larger than the (capped) result set.
    if (all.length > filtered.length) {
      const footer = listEl.createDiv({
        cls: "obsidian-agents-model-modal-footer",
      });
      footer.setText(`Showing ${filtered.length} of ${all.length}.`);
    }
  }

  private renderAuthRow(
    container: HTMLElement,
    method: AuthInfo,
    dialog: HTMLElement
  ): void {
    const row = container.createDiv({
      cls:
        "obsidian-agents-model-modal-item" +
        (method.id === this.modalSelectedAuthId ? " selected" : ""),
    });
    row.createSpan({
      cls: "obsidian-agents-model-modal-item-label",
      text: method.label,
    });
    row.addEventListener("click", () => {
      this.modalSelectedAuthId = method.id;
      this.renderModal(dialog);
    });
  }

  private applySelection(modelId: string): void {
    const slug = this.modalSelectedProviderSlug;
    if (!slug) return;
    const provider = getProvider(slug);
    if (!provider) return;

    try {
      writeActiveModel({
        provider: provider.configSlug ?? provider.slug,
        model: modelId,
        baseUrl: provider.baseUrl || null,
      });
      new Notice(`Switched to ${provider.name} · ${modelId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Failed to update Hermes config: ${msg}`);
      return;
    }

    this.closeModal();
    this.refreshAfterChange();
  }

  private refreshAfterChange(): void {
    this.refreshButton();
    if (this.cardEl) this.renderCard();
    if (this.effortSubCardEl) {
      this.effortSubCardEl.remove();
      this.effortSubCardEl = null;
    }
    this.handlers.onChanged?.();
  }

  onunload(): void {
    document.removeEventListener("click", this.onDocClick);
    document.removeEventListener("keydown", this.onModalKeydown);
    this.closeModal();
    this.hideCard();
  }
}
