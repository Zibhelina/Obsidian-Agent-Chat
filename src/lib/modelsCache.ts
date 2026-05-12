/**
 * Reads the models.dev catalog cache that Hermes maintains at
 * `~/.hermes/models_dev_cache.json`. Used by the settings UI to populate
 * provider + model autocomplete so users don't have to memorize slugs.
 *
 * The cache is the same one Hermes itself routes against, so anything that
 * appears here is something the gateway can dispatch to (assuming the
 * relevant provider key is configured).
 */
import { existsSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CACHE_PATH = join(homedir(), ".hermes", "models_dev_cache.json");

export interface ProviderEntry {
  id: string;
  name: string;
  models: ModelEntry[];
}

export interface ModelEntry {
  id: string;            // e.g. "claude-opus-4-7"
  slug: string;          // e.g. "anthropic/claude-opus-4-7" — what to send to gateway
  name: string;
  reasoning: boolean;
  toolCall: boolean;
  contextLimit?: number;
  costInput?: number;
  costOutput?: number;
}

export interface CatalogResult {
  providers: ProviderEntry[];
  // Flat list across all providers for the model autocomplete.
  allModels: ModelEntry[];
  source: "cache" | "missing" | "error";
  error?: string;
}

interface RawProvider {
  id?: string;
  name?: string;
  models?: Record<string, RawModel>;
}

interface RawModel {
  id?: string;
  name?: string;
  reasoning?: boolean;
  tool_call?: boolean;
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number };
}

let cached: { mtimeMs: number; result: CatalogResult } | null = null;

export function loadModelCatalog(): CatalogResult {
  if (!existsSync(CACHE_PATH)) {
    return { providers: [], allModels: [], source: "missing" };
  }
  try {
    const stat = statSync(CACHE_PATH);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.result;

    const raw = JSON.parse(readFileSync(CACHE_PATH, "utf-8")) as Record<string, RawProvider>;
    const providers: ProviderEntry[] = [];
    const allModels: ModelEntry[] = [];

    for (const [providerId, p] of Object.entries(raw)) {
      if (!p || typeof p !== "object") continue;
      const modelsObj = p.models ?? {};
      const models: ModelEntry[] = [];
      for (const [modelId, m] of Object.entries(modelsObj)) {
        if (!m || typeof m !== "object") continue;
        const id = m.id || modelId;
        const entry: ModelEntry = {
          id,
          slug: `${providerId}/${id}`,
          name: m.name || id,
          reasoning: !!m.reasoning,
          toolCall: !!m.tool_call,
          contextLimit: m.limit?.context,
          costInput: m.cost?.input,
          costOutput: m.cost?.output,
        };
        models.push(entry);
        allModels.push(entry);
      }
      // Sort models alphabetically within a provider for predictable scanning.
      models.sort((a, b) => a.id.localeCompare(b.id));
      providers.push({ id: providerId, name: p.name || providerId, models });
    }
    providers.sort((a, b) => a.name.localeCompare(b.name));
    allModels.sort((a, b) => a.slug.localeCompare(b.slug));

    const result: CatalogResult = { providers, allModels, source: "cache" };
    cached = { mtimeMs: stat.mtimeMs, result };
    return result;
  } catch (err) {
    return {
      providers: [],
      allModels: [],
      source: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function getCatalogPath(): string {
  return CACHE_PATH;
}

/**
 * Filter a flat model list by a free-form query. Matches against slug or
 * display name, case-insensitive, in token order so "opus 4" finds
 * "anthropic/claude-opus-4-7".
 */
export function filterModels(models: ModelEntry[], query: string, limit = 50): ModelEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return models.slice(0, limit);
  const tokens = q.split(/\s+/).filter(Boolean);
  const out: ModelEntry[] = [];
  for (const m of models) {
    const hay = `${m.slug} ${m.name}`.toLowerCase();
    if (tokens.every((t) => hay.includes(t))) {
      out.push(m);
      if (out.length >= limit) break;
    }
  }
  return out;
}
