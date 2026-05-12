import type { App } from "obsidian";

const AGENT_VAULT_ROOT = ".obsidian/plugins/obsidian-agents/agent-vault";
const RUNTIME_ROOT = `${AGENT_VAULT_ROOT}/runtime`;

export interface RuntimePaths {
  originalsDir: string;
  derivativesDir: string;
  contextBundlePath: string;
}

export function getRuntimePaths(sessionId: string, messageId: string): RuntimePaths {
  const safeSession = sanitizePathSegment(sessionId, "session");
  const safeMessage = sanitizePathSegment(messageId, "message");
  return {
    originalsDir: `${RUNTIME_ROOT}/attachments/${safeSession}/${safeMessage}/originals`,
    derivativesDir: `${RUNTIME_ROOT}/derivatives/${safeSession}/${safeMessage}`,
    contextBundlePath: `${RUNTIME_ROOT}/context-bundles/${safeSession}/${safeMessage}.json`,
  };
}

export function sanitizeFileName(name: string, fallback = "attachment"): string {
  const base = name
    .split(/[\\/]/)
    .pop()
    ?.replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"|?*]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  const cleaned = base && base !== "." && base !== ".." ? base : fallback;
  return cleaned.slice(0, 180);
}

export async function ensureFolderPath(app: App, folderPath: string): Promise<void> {
  const parts = folderPath.split("/").filter(Boolean);
  let cursor = "";
  for (const part of parts) {
    cursor = cursor ? `${cursor}/${part}` : part;
    try {
      await app.vault.adapter.mkdir(cursor);
    } catch {
      // Existing folders throw on some adapters. Ignore and continue.
    }
  }
}

export async function writeBinaryVaultFile(
  app: App,
  vaultPath: string,
  bytes: ArrayBuffer
): Promise<void> {
  const parent = vaultPath.split("/").slice(0, -1).join("/");
  if (parent) await ensureFolderPath(app, parent);
  const adapter = app.vault.adapter as unknown as {
    writeBinary?: (path: string, data: ArrayBuffer) => Promise<void>;
    write?: (path: string, data: string) => Promise<void>;
  };
  if (typeof adapter.writeBinary === "function") {
    await adapter.writeBinary(vaultPath, bytes);
    return;
  }
  if (typeof adapter.write === "function") {
    await adapter.write(vaultPath, arrayBufferToBinaryString(bytes));
    return;
  }
  throw new Error("Vault adapter cannot write binary files.");
}

export async function writeTextVaultFile(app: App, vaultPath: string, text: string): Promise<void> {
  const parent = vaultPath.split("/").slice(0, -1).join("/");
  if (parent) await ensureFolderPath(app, parent);
  await app.vault.adapter.write(vaultPath, text);
}

export function vaultPathToLocalPath(app: App, vaultPath: string): string | undefined {
  const adapter = app.vault.adapter as unknown as { getFullPath?: (path: string) => string };
  try {
    return adapter.getFullPath?.(vaultPath);
  } catch {
    return undefined;
  }
}

export async function nextAvailableVaultPath(app: App, dir: string, fileName: string): Promise<string> {
  const safe = sanitizeFileName(fileName);
  const dot = safe.lastIndexOf(".");
  const stem = dot > 0 ? safe.slice(0, dot) : safe;
  const ext = dot > 0 ? safe.slice(dot) : "";
  for (let i = 1; i < 1000; i++) {
    const suffix = i === 1 ? "" : `-${i}`;
    const candidate = `${dir}/${stem}${suffix}${ext}`;
    if (!(await app.vault.adapter.exists(candidate))) return candidate;
  }
  return `${dir}/${stem}-${Date.now()}${ext}`;
}

function sanitizePathSegment(value: string, fallback: string): string {
  return sanitizeFileName(value, fallback).replace(/\./g, "-");
}

function arrayBufferToBinaryString(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let out = "";
  for (let i = 0; i < view.length; i++) out += String.fromCharCode(view[i]);
  return out;
}
