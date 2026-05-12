import type { App } from "obsidian";
import type { ChatMessage, ChatSession, TraceArtifactRef } from "./types";

const TRACE_ROOT = ".obsidian/plugins/obsidian-agents/agent-vault/traces";

interface TraceArtifact {
  version: 1;
  sessionId: string;
  messageId: string;
  messageTimestamp: number;
  archivedAt: number;
  model?: string;
  provider?: string;
  thinking?: string;
  toolCalls?: unknown[];
  contextDebug?: unknown;
}

export function getTraceArtifactPath(sessionId: string, messageId: string): string {
  return `${TRACE_ROOT}/${safeSegment(sessionId)}/${safeSegment(messageId)}.trace.json`;
}

export function hasTracePayload(message: ChatMessage): boolean {
  const metadata = message.metadata;
  if (!metadata) return false;
  return Boolean(
    metadata.thinking ||
      (metadata.toolCalls && metadata.toolCalls.length > 0) ||
      metadata.contextDebug
  );
}

export async function compactSessionsForStorage(
  app: App,
  sessions: ChatSession[]
): Promise<ChatSession[]> {
  const compacted: ChatSession[] = [];
  for (const session of sessions) {
    const messages: ChatMessage[] = [];
    for (const message of session.messages) {
      messages.push(await compactMessageForStorage(app, session.id, message));
    }
    compacted.push({ ...session, messages });
  }
  return compacted;
}

async function compactMessageForStorage(
  app: App,
  sessionId: string,
  message: ChatMessage
): Promise<ChatMessage> {
  const metadata = message.metadata;
  if (!metadata || !hasTracePayload(message)) return message;

  let traceRef: TraceArtifactRef;
  try {
    traceRef = await writeTraceArtifact(app, sessionId, message);
  } catch {
    // Do not risk losing chat history if archival fails. Persist the original
    // payload; the next save can try to compact it again.
    return message;
  }

  metadata.traceRef = traceRef;

  const compactMetadata = { ...metadata };
  delete compactMetadata.thinking;
  delete compactMetadata.toolCalls;
  delete compactMetadata.contextDebug;
  compactMetadata.traceRef = traceRef;

  return {
    ...message,
    metadata: compactMetadata,
  };
}

async function writeTraceArtifact(
  app: App,
  sessionId: string,
  message: ChatMessage
): Promise<TraceArtifactRef> {
  const metadata = message.metadata ?? {};
  const archivedAt = Date.now();
  const path = getTraceArtifactPath(sessionId, message.id);

  await ensureFolder(app, `${TRACE_ROOT}/${safeSegment(sessionId)}`);

  const artifact: TraceArtifact = {
    version: 1,
    sessionId,
    messageId: message.id,
    messageTimestamp: message.timestamp,
    archivedAt,
    model: metadata.model,
    provider: metadata.provider,
    thinking: metadata.thinking,
    toolCalls: metadata.toolCalls,
    contextDebug: metadata.contextDebug,
  };

  await app.vault.adapter.write(path, JSON.stringify(artifact, null, 2));

  return {
    path,
    createdAt: archivedAt,
    thinkingChars: metadata.thinking?.length,
    toolCallCount: metadata.toolCalls?.length,
    hasContextDebug: Boolean(metadata.contextDebug),
  };
}

async function ensureFolder(app: App, path: string): Promise<void> {
  const parts = path.split("/").filter(Boolean);
  let cursor = "";
  for (const part of parts) {
    cursor = cursor ? `${cursor}/${part}` : part;
    try {
      await app.vault.adapter.mkdir(cursor);
    } catch {
      /* already exists or another writer created it */
    }
  }
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}
