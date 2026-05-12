import { App, TFile, TFolder } from "obsidian";
import type {
  Attachment,
  ContextBundle,
  ContextDerivative,
  ContextItem,
  ContextItemKind,
  ContextItemSource,
  ContextItemStatus,
  ContextOriginal,
} from "../types";
import {
  getRuntimePaths,
  nextAvailableVaultPath,
  sanitizeFileName,
  vaultPathToLocalPath,
  writeBinaryVaultFile,
  writeTextVaultFile,
} from "../lib/agentVaultRuntime";
import { parseMentionOccurrences } from "./mentions";

const IMAGE_MAX_EDGE = 1280;
const IMAGE_QUALITY = 0.85;

export interface BuildContextBundleInput {
  app: App;
  sessionId: string;
  messageId: string;
  text: string;
  attachments: Attachment[];
}

export interface BuildContextBundleResult {
  text: string;
  bundle: ContextBundle;
  apiAttachments: Attachment[];
}

interface ImageDerivativeResult {
  dataUrl: string;
  bytes: ArrayBuffer;
  sourceWidth: number;
  sourceHeight: number;
  width: number;
  height: number;
  mime: "image/jpeg";
}

export async function buildContextBundle(
  input: BuildContextBundleInput
): Promise<BuildContextBundleResult> {
  const paths = getRuntimePaths(input.sessionId, input.messageId);
  const items: ContextItem[] = [];
  const apiAttachments: Attachment[] = [];
  const { text } = await replaceMentions(input.app, input.text, items);

  let outputText = text;
  const attachmentRefs: string[] = [];
  for (const attachment of input.attachments ?? []) {
    const item = await buildAttachmentItem(input.app, paths, nextContextId(items), attachment);
    items.push(item.item);
    if (item.apiAttachment) apiAttachments.push(item.apiAttachment);
    attachmentRefs.push(`[${item.item.id}: ${item.item.name}]`);
  }

  if (attachmentRefs.length > 0) {
    outputText = appendAttachedContext(outputText, attachmentRefs);
  }

  const bundle: ContextBundle = {
    version: 1,
    sessionId: input.sessionId,
    messageId: input.messageId,
    createdAt: Date.now(),
    items,
  };

  if (items.length > 0) {
    bundle.bundlePath = paths.contextBundlePath;
    try {
      await writeTextVaultFile(input.app, paths.contextBundlePath, JSON.stringify(bundle, null, 2));
    } catch (error) {
      bundle.error = errorMessage(error);
    }
  }

  return { text: outputText, bundle, apiAttachments };
}

export function renderContextBundleForPrompt(text: string, bundle: ContextBundle): string {
  if (bundle.items.length === 0) return text;
  return `${text}\n\n<context_bundle version="${bundle.version}">\n${JSON.stringify(
    bundle,
    null,
    2
  )}\n</context_bundle>`;
}

async function replaceMentions(
  app: App,
  text: string,
  items: ContextItem[]
): Promise<{ text: string; mentions: ContextItem[] }> {
  const mentions = parseMentionOccurrences(text);
  if (mentions.length === 0) return { text, mentions: [] };

  let cursor = 0;
  let out = "";
  const mentionItems: ContextItem[] = [];
  for (const mention of mentions) {
    const item = buildMentionItem(app, nextContextId(items), mention.path, mention.label);
    items.push(item);
    mentionItems.push(item);
    out += text.slice(cursor, mention.tokenStart);
    out += `[${item.id}: ${item.name}]`;
    cursor = mention.tokenEnd;
  }
  out += text.slice(cursor);
  return { text: out, mentions: mentionItems };
}

function buildMentionItem(app: App, id: string, path: string, label?: string): ContextItem {
  const abstract = app.vault.getAbstractFileByPath(path);
  const fallbackName = label || basename(path) || path;
  if (abstract instanceof TFile) {
    const mime = mimeFromName(abstract.name);
    const kind = kindFromPath(abstract.path, abstract.extension, mime);
    return {
      id,
      source: "mention",
      kind,
      name: label || abstract.name,
      localPath: vaultPathToLocalPath(app, abstract.path),
      vaultPath: abstract.path,
      mime,
      sizeBytes: abstract.stat.size,
      status: mentionStatusForKind(kind),
    };
  }

  if (abstract instanceof TFolder) {
    return {
      id,
      source: "mention",
      kind: "folder",
      name: label || abstract.name || fallbackName,
      localPath: vaultPathToLocalPath(app, abstract.path),
      vaultPath: abstract.path,
      status: "referenced_not_inlined",
    };
  }

  return {
    id,
    source: "mention",
    kind: "unknown",
    name: fallbackName,
    vaultPath: path,
    status: "failed",
    error: `Vault path not found: ${path}`,
  };
}

async function buildAttachmentItem(
  app: App,
  paths: ReturnType<typeof getRuntimePaths>,
  id: string,
  attachment: Attachment
): Promise<{ item: ContextItem; apiAttachment?: Attachment }> {
  const source = normalizeAttachmentSource(attachment);
  const name = sanitizeFileName(attachment.name || attachment.path || id, `${id}.bin`);
  const mime = attachment.mime || mimeFromName(name) || mimeFromDataUrl(attachment.dataUrl);
  const kind = kindFromAttachment(attachment, mime);
  const base: ContextItem = {
    id,
    source,
    kind,
    name,
    mime,
    sizeBytes: attachment.sizeBytes,
    status: "referenced_not_inlined",
  };

  if (!attachment.dataUrl && attachment.path) {
    const existing = app.vault.getAbstractFileByPath(attachment.path);
    if (existing instanceof TFile) {
      base.name = existing.name;
      base.vaultPath = existing.path;
      base.localPath = vaultPathToLocalPath(app, existing.path);
      base.sizeBytes = existing.stat.size;
      base.mime = mimeFromName(existing.name);
      base.kind = kindFromPath(existing.path, existing.extension, base.mime);
      base.status = mentionStatusForKind(base.kind);
      return { item: base };
    }
  }

  const originalBytes = getAttachmentBytes(attachment);
  if (!originalBytes) {
    base.status = "failed";
    base.error = "Attachment bytes were not available at send time.";
    return { item: base };
  }

  try {
    const originalPath = await nextAvailableVaultPath(app, paths.originalsDir, name);
    await writeBinaryVaultFile(app, originalPath, originalBytes);
    base.original = buildOriginal(app, originalPath, mime, originalBytes.byteLength);
    base.vaultPath = originalPath;
    base.localPath = base.original.localPath;
    base.sizeBytes = originalBytes.byteLength;
  } catch (error) {
    base.status = "failed";
    base.error = errorMessage(error);
    return { item: base };
  }

  if (kind === "image" && !isSvg(mime, name)) {
    return buildImageAttachment(app, paths, base, attachment, originalBytes, mime);
  }

  if (kind === "audio") {
    base.status = attachment.dataUrl ? "included_audio" : "referenced_not_inlined";
    return {
      item: base,
      apiAttachment: attachment.dataUrl
        ? { ...stripRuntimeAttachment(attachment), path: base.vaultPath ?? attachment.path, mime, sizeBytes: base.sizeBytes }
        : undefined,
    };
  }

  base.status = "referenced_not_inlined";
  return { item: base };
}

async function buildImageAttachment(
  app: App,
  paths: ReturnType<typeof getRuntimePaths>,
  item: ContextItem,
  attachment: Attachment,
  originalBytes: ArrayBuffer,
  mime?: string
): Promise<{ item: ContextItem; apiAttachment?: Attachment }> {
  const sourceDataUrl =
    mime && originalBytes.byteLength > 0
      ? arrayBufferToDataUrl(originalBytes, mime)
      : attachment.dataUrl;
  if (!sourceDataUrl) {
    item.status = "referenced_not_inlined";
    return { item };
  }

  try {
    const derivative = await createImageDerivative(sourceDataUrl, {
      maxEdge: IMAGE_MAX_EDGE,
      quality: IMAGE_QUALITY,
    });
    const derivativePath = `${paths.derivativesDir}/${item.id}.preview.jpg`;
    await writeBinaryVaultFile(app, derivativePath, derivative.bytes);

    if (item.original) {
      item.original.width = derivative.sourceWidth;
      item.original.height = derivative.sourceHeight;
    }
    const derivativeMeta: ContextDerivative = {
      id: `${item.id}_preview`,
      role: "visual_proxy",
      localPath: vaultPathToLocalPath(app, derivativePath) ?? derivativePath,
      vaultPath: derivativePath,
      mime: derivative.mime,
      width: derivative.width,
      height: derivative.height,
      sizeBytes: derivative.bytes.byteLength,
      maxEdge: IMAGE_MAX_EDGE,
      quality: IMAGE_QUALITY,
      includedInRequest: true,
    };
    item.derivatives = [derivativeMeta];
    item.status = "included_visual_proxy";

    return {
      item,
      apiAttachment: {
        ...stripRuntimeAttachment(attachment),
        name: item.name,
        path: derivativePath,
        dataUrl: derivative.dataUrl,
        mime: derivative.mime,
        sizeBytes: derivative.bytes.byteLength,
      },
    };
  } catch (error) {
    item.status = "referenced_not_inlined";
    item.error = errorMessage(error);
    return { item };
  }
}

export async function createImageDerivative(
  fileOrDataUrl: File | string,
  opts: { maxEdge: number; quality: number }
): Promise<ImageDerivativeResult> {
  const dataUrl = typeof fileOrDataUrl === "string" ? fileOrDataUrl : await fileToDataUrl(fileOrDataUrl);
  const image = await loadImage(dataUrl);
  const scale = Math.min(1, opts.maxEdge / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not create canvas context.");
  ctx.drawImage(image, 0, 0, width, height);

  const blob = await canvasToBlob(canvas, "image/jpeg", opts.quality);
  const bytes = await blob.arrayBuffer();
  const derivativeDataUrl = await blobToDataUrl(blob);
  return {
    dataUrl: derivativeDataUrl,
    bytes,
    sourceWidth: image.width,
    sourceHeight: image.height,
    width,
    height,
    mime: "image/jpeg",
  };
}

function appendAttachedContext(text: string, refs: string[]): string {
  const trimmed = text.trimEnd();
  const prefix = trimmed.length > 0 ? `${trimmed}\n\n` : "";
  return `${prefix}Attached context: ${refs.join(", ")}`;
}

function buildOriginal(app: App, vaultPath: string, mime: string | undefined, sizeBytes: number): ContextOriginal {
  return {
    localPath: vaultPathToLocalPath(app, vaultPath) ?? vaultPath,
    vaultPath,
    mime,
    sizeBytes,
  };
}

function nextContextId(items: ContextItem[]): string {
  return `ctx_${items.length + 1}`;
}

function normalizeAttachmentSource(attachment: Attachment): ContextItemSource {
  if (
    attachment.source === "paste" ||
    attachment.source === "drop" ||
    attachment.source === "mention" ||
    attachment.source === "screenshot"
  ) {
    return attachment.source;
  }
  return "attachment";
}

function kindFromAttachment(attachment: Attachment, mime?: string): ContextItemKind {
  if (attachment.type === "image") return "image";
  if (attachment.type === "pdf") return "pdf";
  if (attachment.type === "audio") return "audio";
  return kindFromPath(attachment.name || attachment.path, undefined, mime);
}

function kindFromPath(path: string, ext?: string, mime?: string): ContextItemKind {
  const lowerExt = (ext || path.split(".").pop() || "").toLowerCase();
  if (mime?.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "tiff", "tif"].includes(lowerExt)) {
    return "image";
  }
  if (mime?.startsWith("audio/") || ["mp3", "wav", "ogg", "flac", "m4a", "webm", "aac", "opus"].includes(lowerExt)) {
    return "audio";
  }
  if (mime?.startsWith("video/") || ["mp4", "mov", "avi", "mkv", "webm"].includes(lowerExt)) {
    return "video";
  }
  if (mime === "application/pdf" || lowerExt === "pdf") return "pdf";
  if (lowerExt === "csv") return "csv";
  if (isTextExtension(lowerExt) || mime?.startsWith("text/")) return "text";
  if (!lowerExt) return "unknown";
  return "binary";
}

function mentionStatusForKind(kind: ContextItemKind): ContextItemStatus {
  return kind === "text" || kind === "csv" ? "available_not_loaded" : "referenced_not_inlined";
}

function isTextExtension(ext: string): boolean {
  return [
    "md",
    "txt",
    "ts",
    "tsx",
    "js",
    "jsx",
    "json",
    "yaml",
    "yml",
    "css",
    "html",
    "xml",
    "py",
    "rb",
    "go",
    "rs",
    "java",
    "c",
    "cpp",
    "h",
    "hpp",
    "sh",
    "zsh",
    "toml",
    "ini",
    "sql",
  ].includes(ext);
}

function mimeFromName(name: string): string | undefined {
  const ext = name.toLowerCase().split(".").pop() || "";
  const table: Record<string, string> = {
    md: "text/markdown",
    txt: "text/plain",
    csv: "text/csv",
    json: "application/json",
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    ogg: "audio/ogg",
    flac: "audio/flac",
    mp4: "video/mp4",
    mov: "video/quicktime",
  };
  return table[ext];
}

function mimeFromDataUrl(dataUrl: string | undefined): string | undefined {
  const match = dataUrl?.match(/^data:([^;,]+)[;,]/);
  return match?.[1];
}

function isSvg(mime: string | undefined, name: string): boolean {
  return mime === "image/svg+xml" || name.toLowerCase().endsWith(".svg");
}

function getAttachmentBytes(attachment: Attachment): ArrayBuffer | null {
  if (attachment.originalBytes instanceof ArrayBuffer) return attachment.originalBytes;
  if (attachment.dataUrl) return dataUrlToArrayBuffer(attachment.dataUrl);
  return null;
}

function stripRuntimeAttachment(attachment: Attachment): Attachment {
  const { originalBytes: _originalBytes, ...rest } = attachment;
  return rest;
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function dataUrlToArrayBuffer(dataUrl: string): ArrayBuffer | null {
  const comma = dataUrl.indexOf(",");
  if (comma === -1) return null;
  const encoded = dataUrl.slice(comma + 1);
  try {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  } catch {
    return null;
  }
}

function arrayBufferToDataUrl(bytes: ArrayBuffer, mime: string): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.length; i++) binary += String.fromCharCode(view[i]);
  return `data:${mime};base64,${btoa(binary)}`;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Could not read image file."));
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not load image for derivative."));
    image.src = dataUrl;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Could not encode image derivative."));
      },
      mime,
      quality
    );
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Could not encode derivative data URL."));
    reader.readAsDataURL(blob);
  });
}
