import type { App, TFile } from "obsidian";
import type { Attachment } from "../types";

function generateId(): string {
	return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export async function handlePasteEvent(
	evt: ClipboardEvent,
	app: App
): Promise<Attachment[]> {
	const attachments: Attachment[] = [];
	const items = evt.clipboardData?.items;
	if (!items) return attachments;

	for (const item of Array.from(items)) {
		if (item.kind === "file") {
			const file = item.getAsFile();
			if (!file) continue;

			const type = getAttachmentType(file.name);
			const dataUrl = await encodeAttachmentFile(file, type);
			attachments.push({
				id: generateId(),
				type,
				name: file.name,
				path: "",
				dataUrl,
				mime: file.type || undefined,
				sizeBytes: file.size,
				source: "paste",
				originalBytes: await file.arrayBuffer(),
				audioFormat: type === "audio" ? getAudioFormat(file.name) ?? undefined : undefined,
			});
		}
	}

	return attachments;
}

export async function handleDropEvent(
	evt: DragEvent,
	app: App
): Promise<Attachment[]> {
	const attachments: Attachment[] = [];
	const files = evt.dataTransfer?.files;
	const items = evt.dataTransfer?.items;

	if (!files && !items) return attachments;

	for (const file of Array.from(files ?? [])) {
		const type = getAttachmentType(file.name);
		attachments.push({
			id: generateId(),
			type,
			name: file.name,
			path: "",
			dataUrl: await encodeAttachmentFile(file, type),
			mime: file.type || undefined,
			sizeBytes: file.size,
			source: "drop",
			originalBytes: await file.arrayBuffer(),
			audioFormat: type === "audio" ? getAudioFormat(file.name) ?? undefined : undefined,
		});
	}

	// Handle internal vault file drops via dataTransfer text/uri-list or custom data
	const uriList = evt.dataTransfer?.getData("text/uri-list") ?? "";
	for (const line of uriList.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const vaultFile = app.vault.getAbstractFileByPath(trimmed);
		if (vaultFile instanceof (await import("obsidian")).TFile) {
			attachments.push({
				id: generateId(),
				type: getAttachmentType(vaultFile.name),
				name: vaultFile.name,
				path: vaultFile.path,
				source: "drop",
			});
		}
	}

	return attachments;
}

export function renderAttachmentPreview(
	container: HTMLElement,
	attachments: Attachment[],
	onRemove: (id: string) => void
): void {
	container.empty();
	if (attachments.length === 0) {
		container.style.display = "none";
		return;
	}
	container.style.display = "flex";
	container.addClass("obsidian-agents-attachment-list");

	for (const att of attachments) {
		const chip = container.createDiv({ cls: "obsidian-agents-attachment-chip" });

		const label = chip.createSpan({ cls: "obsidian-agents-attachment-name" });
		label.setText(att.name);

		if (att.dataUrl && att.type === "image") {
			const thumb = chip.createEl("img", { cls: "obsidian-agents-attachment-thumb" });
			thumb.src = att.dataUrl;
		}

		const removeBtn = chip.createEl("button", { cls: "obsidian-agents-attachment-remove" });
		removeBtn.setText("\u00d7");
		removeBtn.addEventListener("click", () => onRemove(att.id));
	}
}

function fileToDataUrl(file: File): Promise<string> {
	return new Promise((resolve) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = () => resolve("");
		reader.readAsDataURL(file);
	});
}

// Downscale + re-encode pasted images so a full-window screenshot doesn't
// blow past the API gateway's request body cap (observed 413 on ~3MB PNGs).
// Longest edge is capped at MAX_EDGE; transparent sources keep PNG, everything
// else becomes JPEG at QUALITY.
const MAX_EDGE = 1600;
const QUALITY = 0.85;

export async function encodeAttachmentFile(
	file: File,
	type: "image" | "pdf" | "file" | "audio"
): Promise<string> {
	return type === "image" ? imageToDataUrl(file) : fileToDataUrl(file);
}

export function getAttachmentTypeFromFile(file: File): "image" | "pdf" | "file" | "audio" {
	if (file.type.startsWith("image/")) return "image";
	if (file.type.startsWith("audio/")) return "audio";
	if (file.type === "application/pdf") return "pdf";
	return getAttachmentType(file.name);
}

// Map a file extension to the OpenAI-compat `input_audio.format` value.
// Returns null for non-audio extensions.
export function getAudioFormat(name: string): string | null {
	const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
	if (!m) return null;
	const ext = m[1];
	// OpenAI/OpenRouter currently accept "mp3" and "wav"; Gemini also handles
	// flac/ogg/m4a/webm in practice. Pass through the bare extension and let
	// the upstream provider validate.
	const audioExts = new Set(["mp3","wav","ogg","flac","m4a","webm","aac","opus"]);
	return audioExts.has(ext) ? ext : null;
}

async function imageToDataUrl(file: File): Promise<string> {
	// SVGs are text — no raster resampling, just read as-is.
	if (file.type === "image/svg+xml") return fileToDataUrl(file);

	const bitmap = await loadBitmap(file);
	if (!bitmap) return fileToDataUrl(file);

	const { width, height } = bitmap;
	const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
	const targetW = Math.max(1, Math.round(width * scale));
	const targetH = Math.max(1, Math.round(height * scale));

	const canvas = document.createElement("canvas");
	canvas.width = targetW;
	canvas.height = targetH;
	const ctx = canvas.getContext("2d");
	if (!ctx) return fileToDataUrl(file);
	ctx.drawImage(bitmap as CanvasImageSource, 0, 0, targetW, targetH);

	const mime = file.type === "image/png" ? "image/png" : "image/jpeg";
	return canvas.toDataURL(mime, QUALITY);
}

async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement | null> {
	if (typeof createImageBitmap === "function") {
		try {
			return await createImageBitmap(file);
		} catch {
			// Fall through to <img> path.
		}
	}
	const url = URL.createObjectURL(file);
	try {
		return await new Promise<HTMLImageElement | null>((resolve) => {
			const img = new Image();
			img.onload = () => resolve(img);
			img.onerror = () => resolve(null);
			img.src = url;
		});
	} finally {
		URL.revokeObjectURL(url);
	}
}

function getAttachmentType(name: string): "image" | "pdf" | "file" | "audio" {
	const lower = name.toLowerCase();
	if (/\.(png|jpg|jpeg|gif|webp|svg|bmp)$/.test(lower)) return "image";
	if (/\.pdf$/.test(lower)) return "pdf";
	if (/\.(mp3|wav|ogg|flac|m4a|webm|aac|opus)$/.test(lower)) return "audio";
	return "file";
}
