import type { ChatMessage, ChatSession, ContextDebugSnapshot } from "../types";
import { estimateTokens } from "../tokenizer";
import { loadModelCatalog } from "./modelsCache";

export interface TokenUsageEstimate {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  inputEstimated: boolean;
  outputEstimated: boolean;
  totalEstimated: boolean;
}

export interface ModelPricing {
  provider?: string;
  model: string;
  inputPerMillion: number;
  outputPerMillion: number;
  source: string;
}

export interface InteractionCostEstimate {
  provider?: string;
  model?: string;
  usage: TokenUsageEstimate;
  pricing?: ModelPricing;
  costUsd?: number;
  estimated: boolean;
  unpricedTokens: number;
  unknownUsage: boolean;
  note?: string;
}

export interface SessionCostEstimate {
  interactionCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd?: number;
  estimated: boolean;
  unpricedTokens: number;
  unknownUsageCount: number;
  unpricedModels: string[];
}

interface UsageSource {
  message?: ChatMessage;
  snapshot?: ContextDebugSnapshot;
  sessionModel?: string;
}

interface StaticPricingEntry {
  provider?: string;
  model: string;
  inputPerMillion?: number;
  outputPerMillion?: number;
}

// Pricing is an estimate and providers change rates over time. Prefer the
// live Hermes models.dev cache when available; keep this table small and easy
// to extend for models that do not publish catalog pricing.
const STATIC_PRICING: StaticPricingEntry[] = [
  { provider: "openai-codex", model: "gpt-5.5" },
  { provider: "openai-codex", model: "gpt-5.4" },
  { provider: "openai-codex", model: "gpt-5.4-mini" },
  { provider: "openai-codex", model: "gpt-5.3-codex" },
  { provider: "openai-codex", model: "gpt-5.2" },
];

export function estimateInteractionCost(source: UsageSource): InteractionCostEstimate {
  const model = pickModel(source);
  const provider = pickProvider(source, model);
  const usage = estimateUsage(source);
  const pricing = findPricing(provider, model);
  const unknownUsage = usage.totalTokens == null;
  let costUsd: number | undefined;
  let note: string | undefined;

  if (pricing) {
    if (usage.inputTokens != null && usage.outputTokens != null) {
      costUsd =
        (usage.inputTokens * pricing.inputPerMillion +
          usage.outputTokens * pricing.outputPerMillion) /
        1_000_000;
    } else if (usage.totalTokens != null) {
      const knownInput = usage.inputTokens ?? 0;
      const knownOutput = usage.outputTokens ?? 0;
      const unknownTokens = Math.max(0, usage.totalTokens - knownInput - knownOutput);
      const conservativeRate = Math.max(pricing.inputPerMillion, pricing.outputPerMillion);
      costUsd =
        (knownInput * pricing.inputPerMillion +
          knownOutput * pricing.outputPerMillion +
          unknownTokens * conservativeRate) /
        1_000_000;
      if (unknownTokens > 0) {
        note = "Separate input/output tokens unavailable; unknown tokens priced at the higher token rate.";
      }
    } else if (usage.inputTokens != null || usage.outputTokens != null) {
      costUsd =
        ((usage.inputTokens ?? 0) * pricing.inputPerMillion +
          (usage.outputTokens ?? 0) * pricing.outputPerMillion) /
        1_000_000;
    }
  } else if (usage.totalTokens != null) {
    note = "Pricing unavailable for this provider/model.";
  }

  return {
    provider,
    model,
    usage,
    pricing,
    costUsd,
    estimated: usage.inputEstimated || usage.outputEstimated || usage.totalEstimated || !!note,
    unpricedTokens: pricing ? 0 : usage.totalTokens ?? 0,
    unknownUsage,
    note,
  };
}

export function estimateSessionCost(session?: ChatSession | null): SessionCostEstimate {
  const messages = session?.messages.filter((message) => message.role === "agent") ?? [];
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let costUsd = 0;
  let hasCost = false;
  let estimated = false;
  let unpricedTokens = 0;
  let unknownUsageCount = 0;
  const unpricedModels = new Set<string>();

  for (const message of messages) {
    const estimate = estimateInteractionCost({
      message,
      snapshot: message.metadata?.contextDebug,
      sessionModel: session?.model,
    });
    inputTokens += estimate.usage.inputTokens ?? 0;
    outputTokens += estimate.usage.outputTokens ?? 0;
    totalTokens += estimate.usage.totalTokens ?? 0;
    estimated = estimated || estimate.estimated;
    if (estimate.costUsd != null) {
      costUsd += estimate.costUsd;
      hasCost = true;
    }
    if (estimate.unknownUsage) unknownUsageCount += 1;
    if (estimate.unpricedTokens > 0) {
      unpricedTokens += estimate.unpricedTokens;
      unpricedModels.add(modelLabel(estimate.provider, estimate.model));
    }
  }

  return {
    interactionCount: messages.length,
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd: hasCost ? costUsd : undefined,
    estimated,
    unpricedTokens,
    unknownUsageCount,
    unpricedModels: Array.from(unpricedModels).sort(),
  };
}

export function formatUsd(value: number | undefined): string {
  if (value == null) return "Pricing unavailable";
  if (value > 0 && value < 0.0001) return "<$0.0001";
  const digits = value < 0.01 ? 6 : 4;
  return `$${value.toFixed(digits)}`;
}

export function modelLabel(provider?: string, model?: string): string {
  if (provider && model) return `${provider}/${model}`;
  return model || provider || "Unknown model";
}

function estimateUsage(source: UsageSource): TokenUsageEstimate {
  const metadata = source.message?.metadata;
  const snapshotInput = source.snapshot?.estimatedTokens;
  const exactInput = metadata?.promptTokens;
  const exactOutput = metadata?.completionTokens;
  const outputFromContent =
    exactOutput == null && source.message?.content
      ? estimateTokens(source.message.content)
      : undefined;

  const inputTokens = exactInput ?? snapshotInput;
  const outputTokens = exactOutput ?? outputFromContent;
  const totalFromParts =
    inputTokens != null && outputTokens != null ? inputTokens + outputTokens : undefined;
  const fallbackTotal = inputTokens ?? outputTokens;
  const totalTokens = totalFromParts ?? metadata?.tokensUsed ?? source.snapshot?.estimatedTokens ?? fallbackTotal;

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    inputEstimated: exactInput == null && inputTokens != null,
    outputEstimated: exactOutput == null && outputTokens != null,
    totalEstimated:
      exactInput == null ||
      exactOutput == null ||
      (totalTokens != null && metadata?.tokensUsed == null && totalFromParts == null),
  };
}

function pickModel(source: UsageSource): string | undefined {
  const model =
    source.message?.metadata?.model ||
    source.snapshot?.model ||
    source.sessionModel;
  return model && model !== "auto" ? model : undefined;
}

function pickProvider(source: UsageSource, model?: string): string | undefined {
  return (
    source.message?.metadata?.provider ||
    source.snapshot?.provider ||
    inferProvider(model)
  );
}

function findPricing(provider?: string, model?: string): ModelPricing | undefined {
  if (!model) return undefined;
  const catalog = loadModelCatalog();
  const exactSlug = provider ? `${provider}/${model}` : model;
  const catalogMatch =
    catalog.allModels.find((entry) => entry.slug === exactSlug) ||
    catalog.allModels.find((entry) => entry.slug === model) ||
    catalog.allModels.find((entry) => provider && entry.slug === `${provider}/${entry.id}` && entry.id === model) ||
    uniqueByModel(catalog.allModels.filter((entry) => entry.id === model));

  if (catalogMatch?.costInput != null && catalogMatch.costOutput != null) {
    return {
      provider: catalogMatch.slug.split("/", 1)[0],
      model: catalogMatch.id,
      inputPerMillion: catalogMatch.costInput,
      outputPerMillion: catalogMatch.costOutput,
      source: "Hermes models.dev catalog",
    };
  }

  const staticMatch = STATIC_PRICING.find(
    (entry) =>
      normalize(entry.model) === normalize(model) &&
      (!entry.provider || !provider || normalize(entry.provider) === normalize(provider))
  );
  if (staticMatch?.inputPerMillion != null && staticMatch.outputPerMillion != null) {
    return {
      provider: staticMatch.provider ?? provider,
      model: staticMatch.model,
      inputPerMillion: staticMatch.inputPerMillion,
      outputPerMillion: staticMatch.outputPerMillion,
      source: "static estimate table",
    };
  }
  return undefined;
}

function uniqueByModel<T>(matches: T[]): T | undefined {
  return matches.length === 1 ? matches[0] : undefined;
}

function inferProvider(model: string | undefined): string | undefined {
  if (!model || !model.includes("/")) return undefined;
  return model.split("/", 1)[0];
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}
