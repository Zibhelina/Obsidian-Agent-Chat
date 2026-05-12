/**
 * Read-only mirror of Hermes' provider catalog so the composer's model picker
 * can show what `hermes model` would show. Limited intentionally: we only
 * surface providers that already have credentials (OAuth token in
 * ~/.hermes/auth.json or API key in ~/.hermes/.env). Login flows still happen
 * via the Hermes CLI.
 *
 * Source of truth in Hermes:
 *  - hermes_cli/models.py:_PROVIDER_MODELS — curated agentic models per provider
 *  - hermes_cli/auth.py:PROVIDER_REGISTRY  — env-var names + base URLs
 *  - ~/.hermes/auth.json                    — OAuth tokens + credential pool
 *  - ~/.hermes/.env                          — API keys
 *
 * If Hermes adds a provider, this file is what to update.
 */
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import { loadModelCatalog } from "./modelsCache";

const HERMES_HOME = join(homedir(), ".hermes");
const AUTH_PATH = join(HERMES_HOME, "auth.json");
const ENV_PATH = join(HERMES_HOME, ".env");

export interface HermesProvider {
  /** Provider slug used by this picker. */
  slug: string;
  /** Provider slug written to config.yaml (model.provider). Defaults to slug. */
  configSlug?: string;
  /** Display name. */
  name: string;
  /** Default base URL — written to model.base_url alongside the slug. */
  baseUrl: string;
  /** Env-var names checked for an API key. Empty for OAuth-only providers. */
  envKeys: readonly string[];
  /** Local credential files checked relative to the user's home directory. */
  credentialFiles?: readonly { path: readonly string[]; label: string; kind: "claude-code" }[];
  /** Curated models, in the order Hermes itself surfaces them. */
  models: readonly string[];
  /** OAuth providers identified by an entry in auth.json. */
  oauth?: boolean;
}

/**
 * Curated provider list mirroring `_PROVIDER_MODELS` in
 * hermes_cli/models.py. Only providers that show up in the canonical Hermes
 * picker are included. Trim ruthlessly when something becomes irrelevant.
 */
const PROVIDERS: HermesProvider[] = [
  {
    slug: "openai-codex",
    name: "OpenAI Codex",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    envKeys: [],
    oauth: true,
    models: [
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex",
      "gpt-5.2",
    ],
  },
  {
    slug: "claude-code",
    configSlug: "anthropic",
    name: "Claude Code",
    baseUrl: "https://api.anthropic.com",
    envKeys: ["CLAUDE_CODE_OAUTH_TOKEN"],
    credentialFiles: [
      { path: [".claude", ".credentials.json"], label: "Claude Code OAuth", kind: "claude-code" },
    ],
    models: [
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-opus-4-5-20251101",
      "claude-sonnet-4-5-20250929",
      "claude-opus-4-20250514",
      "claude-sonnet-4-20250514",
      "claude-haiku-4-5-20251001",
    ],
  },
  {
    slug: "anthropic",
    name: "Anthropic (Claude API)",
    baseUrl: "https://api.anthropic.com",
    envKeys: ["ANTHROPIC_API_KEY", "ANTHROPIC_TOKEN"],
    models: [
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-opus-4-5-20251101",
      "claude-sonnet-4-5-20250929",
      "claude-opus-4-20250514",
      "claude-sonnet-4-20250514",
      "claude-haiku-4-5-20251001",
    ],
  },
  {
    slug: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    envKeys: ["OPENROUTER_API_KEY"],
    models: [
      "anthropic/claude-opus-4.7",
      "anthropic/claude-sonnet-4.6",
      "anthropic/claude-haiku-4.5",
      "openai/gpt-5.4",
      "openai/gpt-5.4-mini",
      "google/gemini-3-pro-preview",
      "google/gemini-3-flash-preview",
      "moonshotai/kimi-k2.6",
      "deepseek/deepseek-v4-pro",
      "x-ai/grok-4.3",
      "x-ai/grok-4.20",
      "x-ai/grok-4.20-multi-agent",
      "z-ai/glm-5.1",
    ],
  },
  {
    slug: "nous",
    name: "Nous Portal",
    baseUrl: "https://inference-api.nousresearch.com/v1",
    envKeys: [],
    oauth: true,
    models: [
      "moonshotai/kimi-k2.6",
      "anthropic/claude-opus-4.7",
      "anthropic/claude-sonnet-4.6",
      "openai/gpt-5.4",
      "google/gemini-3-pro-preview",
      "deepseek/deepseek-v4-pro",
    ],
  },
  {
    slug: "ai-gateway",
    name: "Vercel AI Gateway",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    envKeys: ["AI_GATEWAY_API_KEY"],
    models: [
      "anthropic/claude-opus-4.7",
      "anthropic/claude-sonnet-4.6",
      "openai/gpt-5.4",
      "google/gemini-3-pro-preview",
      "moonshotai/kimi-k2.6",
    ],
  },
  {
    slug: "gemini",
    name: "Google AI Studio",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    envKeys: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
    models: [
      "gemini-3.1-pro-preview",
      "gemini-3-pro-preview",
      "gemini-3-flash-preview",
      "gemini-3.1-flash-lite-preview",
    ],
  },
  {
    slug: "google-gemini-cli",
    name: "Google Gemini (OAuth)",
    baseUrl: "https://cloudcode-pa.googleapis.com",
    envKeys: [],
    oauth: true,
    models: [
      "gemini-3.1-pro-preview",
      "gemini-3-pro-preview",
      "gemini-3-flash-preview",
    ],
  },
  {
    slug: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    envKeys: ["DEEPSEEK_API_KEY"],
    models: [
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "deepseek-chat",
      "deepseek-reasoner",
    ],
  },
  {
    slug: "xai",
    name: "xAI (Grok)",
    baseUrl: "https://api.x.ai/v1",
    envKeys: ["XAI_API_KEY"],
    models: ["grok-4.20-reasoning", "grok-4-1-fast-reasoning"],
  },
  {
    slug: "zai",
    name: "Z.AI / GLM",
    baseUrl: "https://api.z.ai/api/paas/v4",
    envKeys: ["GLM_API_KEY", "ZAI_API_KEY", "Z_AI_API_KEY"],
    models: [
      "glm-5.1",
      "glm-5",
      "glm-5v-turbo",
      "glm-5-turbo",
      "glm-4.7",
      "glm-4.5",
      "glm-4.5-flash",
    ],
  },
  {
    slug: "kimi-coding",
    name: "Kimi / Moonshot",
    baseUrl: "https://api.moonshot.ai/v1",
    envKeys: ["KIMI_API_KEY", "KIMI_CODING_API_KEY"],
    models: [
      "kimi-k2.6",
      "kimi-k2.5",
      "kimi-for-coding",
      "kimi-k2-thinking",
      "kimi-k2-thinking-turbo",
      "kimi-k2-turbo-preview",
      "kimi-k2-0905-preview",
    ],
  },
  {
    slug: "minimax",
    name: "MiniMax",
    baseUrl: "https://api.minimax.io/anthropic",
    envKeys: ["MINIMAX_API_KEY"],
    models: ["MiniMax-M2.7", "MiniMax-M2.5", "MiniMax-M2.1", "MiniMax-M2"],
  },
  {
    slug: "qwen-oauth",
    name: "Qwen OAuth",
    baseUrl: "https://chat.qwen.ai/api",
    envKeys: [],
    oauth: true,
    models: [
      "qwen3.5-plus",
      "qwen3-coder-plus",
      "qwen3-coder-next",
    ],
  },
  {
    slug: "alibaba",
    name: "Alibaba Cloud (DashScope)",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    envKeys: ["DASHSCOPE_API_KEY"],
    models: [
      "kimi-k2.5",
      "qwen3.5-plus",
      "qwen3-coder-plus",
      "qwen3-coder-next",
      "glm-5",
      "glm-4.7",
      "MiniMax-M2.5",
    ],
  },
  {
    slug: "copilot",
    name: "GitHub Copilot",
    baseUrl: "https://api.githubcopilot.com",
    envKeys: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
    models: [
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex",
      "claude-sonnet-4.6",
      "claude-haiku-4.5",
      "gemini-3.1-pro-preview",
      "gemini-3-pro-preview",
    ],
  },
];

interface AuthFile {
  active_provider?: string;
  providers?: Record<string, unknown>;
  credential_pool?: Record<
    string,
    Array<{
      access_token?: string;
      expires_at_ms?: number;
      expires_at?: number;
      last_status?: string;
    }>
  >;
}

function readAuthFile(): AuthFile {
  if (!existsSync(AUTH_PATH)) return {};
  try {
    return JSON.parse(readFileSync(AUTH_PATH, "utf-8")) as AuthFile;
  } catch {
    return {};
  }
}

function readEnvKeys(): Set<string> {
  const set = new Set<string>();
  if (!existsSync(ENV_PATH)) return set;
  try {
    const text = readFileSync(ENV_PATH, "utf-8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (value && value !== '""' && value !== "''") set.add(key);
    }
  } catch {
    /* ignore */
  }
  return set;
}

function hasUsableClaudeOauthRecord(oauthRecord: Record<string, unknown>): boolean {
  const token = oauthRecord.accessToken;
  if (typeof token !== "string" || token.trim().length === 0) return false;

  // Claude Code access tokens are usually refreshable, but if the persisted
  // token is already expired Hermes may fail auth before it can route. Do not
  // advertise Claude Code as an available route unless the local credential
  // has a usable access token right now.
  const expiresAt = Number(oauthRecord.expiresAt || 0);
  return !Number.isFinite(expiresAt) || expiresAt <= 0 || Date.now() < expiresAt - 60_000;
}

function hasClaudeCodeCredentialsFile(pathParts: readonly string[]): boolean {
  const file = join(homedir(), ...pathParts);
  if (!existsSync(file)) return false;
  try {
    const data = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    const oauth = data.claudeAiOauth;
    if (!oauth || typeof oauth !== "object") return false;
    return hasUsableClaudeOauthRecord(oauth as Record<string, unknown>);
  } catch {
    return false;
  }
}

function hasClaudeCodeCredentialsKeychain(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    const raw = execFileSync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
      }
    ).trim();
    if (!raw) return false;
    const data = JSON.parse(raw) as Record<string, unknown>;
    const oauth = data.claudeAiOauth;
    if (!oauth || typeof oauth !== "object") return false;
    return hasUsableClaudeOauthRecord(oauth as Record<string, unknown>);
  } catch {
    return false;
  }
}

function hasClaudeCodeCredentials(pathParts: readonly string[]): boolean {
  return hasClaudeCodeCredentialsKeychain() || hasClaudeCodeCredentialsFile(pathParts);
}

function hasUsableCredentialPoolEntry(auth: AuthFile, slug: string): boolean {
  const entries = auth.credential_pool?.[slug] ?? [];
  return entries.some((entry) => {
    const token = entry.access_token;
    if (typeof token !== "string" || token.trim().length === 0) return false;
    if (entry.last_status === "exhausted") return false;
    const expiresAt = Number(entry.expires_at_ms || entry.expires_at || 0);
    return !Number.isFinite(expiresAt) || expiresAt <= 0 || Date.now() < expiresAt - 60_000;
  });
}

export interface AuthInfo {
  /** Display label for the auth method ("OAuth", "API key (KIMI_API_KEY)", …). */
  label: string;
  /** Stable id — slug of the auth method, used to disambiguate when a provider
      has multiple credentials in play. */
  id: string;
}

export interface AuthenticatedProvider extends HermesProvider {
  authMethods: AuthInfo[];
}

/**
 * Return the providers that currently have at least one credential. Each
 * entry includes the auth methods that satisfied the check, so the UI can
 * label what's in play (OAuth vs. API key vs. multiple keys).
 *
 * Falls back to "no auth" if the relevant files don't exist — in that case
 * the picker should still show a hint to run `hermes login` rather than
 * silently hiding everything.
 */
export function listAuthenticatedProviders(): AuthenticatedProvider[] {
  const auth = readAuthFile();
  const env = readEnvKeys();
  const oauthProviderKeys = new Set(Object.keys(auth.providers ?? {}));

  const out: AuthenticatedProvider[] = [];
  for (const p of PROVIDERS) {
    const methods: AuthInfo[] = [];
    if (p.oauth && oauthProviderKeys.has(p.slug)) {
      methods.push({ id: "oauth", label: "OAuth" });
    }
    for (const k of p.envKeys) {
      if (env.has(k)) methods.push({ id: `env:${k}`, label: `API key (${k})` });
    }
    for (const credentialFile of p.credentialFiles ?? []) {
      if (credentialFile.kind === "claude-code" && hasClaudeCodeCredentials(credentialFile.path)) {
        methods.push({ id: `file:${credentialFile.path.join("/")}`, label: credentialFile.label });
      }
    }
    if (hasUsableCredentialPoolEntry(auth, p.slug)) {
      // Already covered by env-key check in most cases; include it as a
      // fallback signal for providers whose pool lives only in auth.json.
      if (methods.length === 0) {
        methods.push({ id: "pool", label: "Credential pool" });
      }
    }
    if (methods.length > 0) {
      out.push({ ...p, authMethods: methods });
    }
  }
  return out;
}

/** Look up a provider by slug regardless of whether it's authenticated. */
export function getProvider(slug: string): HermesProvider | null {
  return PROVIDERS.find((p) => p.slug === slug) ?? null;
}

/** Full list of known providers, even unauthenticated — for the "needs login" hint. */
export function allKnownProviders(): readonly HermesProvider[] {
  return PROVIDERS;
}

export interface ProviderModelEntry {
  /** Model id sent to the gateway as `model.default`. */
  id: string;
  /** Display label — falls back to the id. */
  name: string;
  /** Optional badge: "recommended" / "free" / "reasoning" / "tools". */
  badges: readonly string[];
}

/**
 * Merge the curated model list (preserves Hermes' recommended ordering and
 * tags like "recommended" / "free") with the live models.dev catalog for
 * providers that publish a rich `/v1/models` endpoint (OpenRouter has 180+
 * models, Anthropic has 20+, etc.). The curated picks come first; everything
 * else is appended alphabetically. De-dupes by id.
 *
 * For providers with no catalog entries (openai-codex, nous, ai-gateway,
 * which Hermes routes statically) only the curated list is returned.
 */
export function getProviderModels(slug: string): ProviderModelEntry[] {
  const provider = getProvider(slug);
  if (!provider) return [];

  const curated = provider.models;
  const catalog = loadModelCatalog();
  const catalogProvider = catalog.providers.find((p) => p.id === slug);
  const catalogModels = catalogProvider?.models ?? [];

  const seen = new Set<string>();
  const out: ProviderModelEntry[] = [];

  // Curated first, in order, with their badges (we don't currently know the
  // badge per curated entry — the static list in this file is just ids — so
  // tag them all "recommended" to surface them above the catalog tail).
  for (const id of curated) {
    if (seen.has(id)) continue;
    seen.add(id);
    const cat = catalogModels.find((m) => m.id === id || m.slug === id);
    const badges: string[] = ["recommended"];
    if (cat?.reasoning) badges.push("reasoning");
    if (cat?.toolCall) badges.push("tools");
    out.push({ id, name: cat?.name || id, badges });
  }

  // Then catalog entries we haven't seen yet.
  for (const m of catalogModels) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    const badges: string[] = [];
    if (m.reasoning) badges.push("reasoning");
    if (m.toolCall) badges.push("tools");
    out.push({ id: m.id, name: m.name, badges });
  }

  return out;
}

/**
 * Token-order substring filter, case-insensitive. Matches against model id
 * and display name so users can search "opus 4.7" or "anthropic 4.7" or
 * "gpt 5". Returns the input list unchanged when the query is empty.
 */
export function filterProviderModels(
  models: readonly ProviderModelEntry[],
  query: string,
  limit = 200
): ProviderModelEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return models.slice(0, limit);
  const tokens = q.split(/\s+/).filter(Boolean);
  const out: ProviderModelEntry[] = [];
  for (const m of models) {
    const hay = `${m.id} ${m.name}`.toLowerCase();
    if (tokens.every((t) => hay.includes(t))) {
      out.push(m);
      if (out.length >= limit) break;
    }
  }
  return out;
}
