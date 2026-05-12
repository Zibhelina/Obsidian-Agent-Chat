import type { App } from "obsidian";
import type { ChatSession, SessionFolder } from "./types";
import { generateId } from "./lib/id";
import { compactSessionsForStorage } from "./traceArtifacts";

const SESSIONS_PATH = ".obsidian/obsidian-agents-sessions.json";
const LEGACY_SESSIONS_PATH = ".obsidian/agentchat-sessions.json";

export function createSession(folderId: string | null): ChatSession {
	const now = Date.now();
	return {
		id: generateId(),
		name: "New Chat",
		folderId,
		messages: [],
		createdAt: now,
		updatedAt: now,
		model: "auto",
	};
}

export function createFolder(parentId: string | null): SessionFolder {
	return {
		id: generateId(),
		name: "New Folder",
		parentId,
		collapsed: false,
	};
}

export async function loadSessions(
	app: App
): Promise<{ sessions: ChatSession[]; folders: SessionFolder[] }> {
	const parse = (raw: string) => {
		const parsed = JSON.parse(raw);
		return {
			sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
			folders: Array.isArray(parsed.folders) ? parsed.folders : [],
		};
	};
	try {
		return parse(await app.vault.adapter.read(SESSIONS_PATH));
	} catch {}
	// One-time migration from the legacy filename (pre-rebrand).
	try {
		const legacy = parse(await app.vault.adapter.read(LEGACY_SESSIONS_PATH));
		await saveSessions(app, legacy);
		return legacy;
	} catch {
		return { sessions: [], folders: [] };
	}
}

export async function saveSessions(
	app: App,
	data: { sessions: ChatSession[]; folders: SessionFolder[] }
): Promise<void> {
	const sessions = await compactSessionsForStorage(app, data.sessions);
	await app.vault.adapter.write(SESSIONS_PATH, JSON.stringify({ ...data, sessions }, null, 2));
}
