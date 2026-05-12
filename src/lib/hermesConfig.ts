/**
 * Minimal read/write helpers for the `approvals.mode` field in
 * `~/.hermes/config.yaml`. We intentionally do NOT pull in a full YAML
 * library — the Hermes config file is simple enough that a targeted regex
 * rewrite of the `approvals:` block is safer (preserves comments + field
 * order) than round-tripping through a YAML parser.
 *
 * The valid values mirror Hermes itself:
 *   - manual — always prompt the user (default, no auto-approve)
 *   - smart  — LLM auto-approves low-risk commands, prompts for high-risk
 *   - off    — skip all approval prompts (equivalent to --yolo)
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { ApprovalMode, ObsidianAgentsSettings } from "../types";

const HERMES_CONFIG_PATH = join(homedir(), ".hermes", "config.yaml");

const VALID_MODES: ReadonlySet<ApprovalMode> = new Set<ApprovalMode>(["manual", "smart", "off"]);
const VALID_REASONING_EFFORTS: ReadonlySet<ObsidianAgentsSettings["effortLevel"]> = new Set<
  ObsidianAgentsSettings["effortLevel"]
>(["minimal", "low", "medium", "high"]);

export function getHermesConfigPath(): string {
  return HERMES_CONFIG_PATH;
}

export function hermesConfigExists(): boolean {
  try {
    return existsSync(HERMES_CONFIG_PATH);
  } catch {
    return false;
  }
}

export function readApprovalMode(): ApprovalMode | null {
  if (!hermesConfigExists()) return null;
  let text: string;
  try {
    text = readFileSync(HERMES_CONFIG_PATH, "utf-8");
  } catch {
    return null;
  }
  // Match a `mode:` key nested under `approvals:` at any indentation.
  const match = text.match(/^approvals\s*:\s*\n(?:\s*#[^\n]*\n)*(\s+)mode\s*:\s*['"]?([a-zA-Z]+)['"]?/m);
  if (!match) return null;
  const value = match[2].toLowerCase();
  return VALID_MODES.has(value as ApprovalMode) ? (value as ApprovalMode) : null;
}

export function readReasoningEffort(): ObsidianAgentsSettings["effortLevel"] | null {
  if (!hermesConfigExists()) return null;
  let text: string;
  try {
    text = readFileSync(HERMES_CONFIG_PATH, "utf-8");
  } catch {
    return null;
  }

  const match = text.match(
    /^agent\s*:\s*\n(?:[ \t]*#[^\n]*\n)*(?:[ \t]+\S[^\n]*\n)*?[ \t]+reasoning_effort\s*:\s*['"]?([a-zA-Z]+)['"]?/m
  );
  if (!match) return null;
  const value = match[1].toLowerCase();
  return VALID_REASONING_EFFORTS.has(value as ObsidianAgentsSettings["effortLevel"])
    ? (value as ObsidianAgentsSettings["effortLevel"])
    : null;
}

/**
 * Rewrite `agent.reasoning_effort` in `~/.hermes/config.yaml` immediately.
 * The API gateway reloads this value on each message before constructing the
 * turn's AIAgent, so a gateway restart is not required for new messages.
 */
export function writeReasoningEffort(effort: ObsidianAgentsSettings["effortLevel"]): void {
  if (!VALID_REASONING_EFFORTS.has(effort)) {
    throw new Error(`Invalid reasoning effort: ${effort}`);
  }

  let text = "";
  if (hermesConfigExists()) {
    text = readFileSync(HERMES_CONFIG_PATH, "utf-8");
  }

  const effortRegex =
    /(^agent\s*:\s*\n(?:[ \t]*#[^\n]*\n)*(?:[ \t]+\S[^\n]*\n)*?)([ \t]+)reasoning_effort\s*:\s*['"]?[a-zA-Z]+['"]?/m;
  if (effortRegex.test(text)) {
    text = text.replace(
      effortRegex,
      (_match, prefix, indent) => `${prefix}${indent}reasoning_effort: ${effort}`
    );
  } else if (/^agent\s*:/m.test(text)) {
    text = text.replace(/^(agent\s*:\s*\n)/m, `$1  reasoning_effort: ${effort}\n`);
  } else {
    if (text.length > 0 && !text.endsWith("\n")) text += "\n";
    text += `\nagent:\n  reasoning_effort: ${effort}\n`;
  }

  writeFileSync(HERMES_CONFIG_PATH, text, "utf-8");
}

/**
 * Read the active model + provider from the `model:` block. Returns nulls if
 * the file or fields are missing. Used by the composer's model picker to
 * display whatever Hermes itself is routing through right now (the gateway
 * resolves the model from this file fresh on every request, see
 * gateway/run.py:_resolve_gateway_model).
 */
export function readActiveModel(): {
  provider: string | null;
  model: string | null;
  baseUrl: string | null;
} {
  if (!hermesConfigExists()) return { provider: null, model: null, baseUrl: null };
  let text: string;
  try {
    text = readFileSync(HERMES_CONFIG_PATH, "utf-8");
  } catch {
    return { provider: null, model: null, baseUrl: null };
  }
  // Match the top-level `model:` mapping. We only care about the first three
  // fields under it. The rest of the block is preserved on writes.
  const blockMatch = text.match(/^model\s*:\s*\n((?:[ \t]+\S[^\n]*\n?)*)/m);
  if (!blockMatch) return { provider: null, model: null, baseUrl: null };
  const block = blockMatch[1];
  const grab = (key: string): string | null => {
    const re = new RegExp(`^[ \\t]+${key}\\s*:\\s*['"]?([^\\n'"]*)['"]?\\s*$`, "m");
    const m = block.match(re);
    return m ? m[1].trim() : null;
  };
  return {
    provider: grab("provider"),
    model: grab("default") || grab("model"),
    baseUrl: grab("base_url"),
  };
}

/**
 * Rewrite the `model.provider`, `model.default`, and (optionally)
 * `model.base_url` keys in-place. Same regex-only approach as approval mode —
 * we deliberately avoid a YAML round-trip so user comments and field order in
 * config.yaml survive the edit.
 *
 * The Hermes gateway reads this file fresh on every chat completion
 * (gateway/run.py:_resolve_gateway_model + _resolve_runtime_agent_kwargs),
 * so the change applies to the next message — no gateway restart needed.
 *
 * Throws on I/O error.
 */
export function writeActiveModel(opts: {
  provider: string;
  model: string;
  baseUrl?: string | null;
}): void {
  let text = "";
  if (hermesConfigExists()) {
    text = readFileSync(HERMES_CONFIG_PATH, "utf-8");
  }

  // Helper: replace or insert a child key under the top-level `model:` block.
  const setKeyUnderModel = (
    src: string,
    key: string,
    value: string | null
  ): string => {
    // null → remove the key entirely (used for base_url when no override).
    const childRe = new RegExp(
      `(^model\\s*:\\s*\\n(?:[ \\t]+(?!\\S)[^\\n]*\\n)*)([ \\t]+)${key}\\s*:\\s*['"]?[^\\n]*?$`,
      "m"
    );
    const childReFlexible = new RegExp(
      `(^model\\s*:\\s*\\n)((?:[ \\t]+\\S[^\\n]*\\n?)*)`,
      "m"
    );

    if (value === null) {
      // Strip the key+line if present.
      const stripRe = new RegExp(
        `(^model\\s*:\\s*\\n(?:[ \\t]+\\S[^\\n]*\\n)*?)[ \\t]+${key}\\s*:[^\\n]*\\n`,
        "m"
      );
      return src.replace(stripRe, "$1");
    }

    if (childRe.test(src)) {
      return src.replace(childRe, (_, header, indent) => `${header}${indent}${key}: ${value}`);
    }
    // Insert as a new child under model: — preserve indentation seen on
    // siblings if any, otherwise default to two spaces.
    const blockMatch = src.match(childReFlexible);
    if (blockMatch) {
      const block = blockMatch[2];
      const indentMatch = block.match(/^([ \t]+)\S/m);
      const indent = indentMatch ? indentMatch[1] : "  ";
      return src.replace(
        childReFlexible,
        (_full, header, body) => `${header}${body}${indent}${key}: ${value}\n`
      );
    }
    // No `model:` block at all — create one.
    if (src.length > 0 && !src.endsWith("\n")) src += "\n";
    return src + `\nmodel:\n  ${key}: ${value}\n`;
  };

  text = setKeyUnderModel(text, "provider", opts.provider);
  text = setKeyUnderModel(text, "default", opts.model);
  // base_url is only meaningful when the provider has a custom endpoint.
  // Strip it otherwise so the gateway falls back to the provider's default.
  text = setKeyUnderModel(text, "base_url", opts.baseUrl ?? null);

  writeFileSync(HERMES_CONFIG_PATH, text, "utf-8");
}

/**
 * Rewrite the `approvals.mode` value in-place. Preserves surrounding
 * comments, indentation, and sibling fields. Creates the file (and
 * `approvals:` block) only if they don't already exist.
 *
 * Throws on I/O error — callers should surface a Notice.
 */
export function writeApprovalMode(mode: ApprovalMode): void {
  if (!VALID_MODES.has(mode)) {
    throw new Error(`Invalid approval mode: ${mode}`);
  }

  let text = "";
  if (hermesConfigExists()) {
    text = readFileSync(HERMES_CONFIG_PATH, "utf-8");
  }

  // Case 1: approvals block exists with a `mode:` inside — replace it.
  const modeRegex =
    /(^approvals\s*:\s*\n(?:\s*#[^\n]*\n)*)(\s+)mode\s*:\s*['"]?[a-zA-Z]+['"]?/m;
  if (modeRegex.test(text)) {
    text = text.replace(modeRegex, (_, header, indent) => `${header}${indent}mode: ${mode}`);
  } else if (/^approvals\s*:/m.test(text)) {
    // Case 2: approvals block exists but no `mode:` — insert on next line.
    text = text.replace(/^(approvals\s*:\s*\n)/m, `$1  mode: ${mode}\n`);
  } else {
    // Case 3: no approvals block — append one.
    if (text.length > 0 && !text.endsWith("\n")) text += "\n";
    text += `\napprovals:\n  mode: ${mode}\n`;
  }

  writeFileSync(HERMES_CONFIG_PATH, text, "utf-8");
}
