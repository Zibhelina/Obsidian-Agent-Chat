import {
  ContextDebugBlock,
  ContextDebugBlockType,
  ContextDebugSnapshot,
} from "./types";
import { estimateTokens } from "./tokenizer";
import { generateId } from "./lib/id";

interface SnapshotArgs {
  rawRequest: unknown;
  requestSource?: ContextDebugSnapshot["requestSource"];
  apiMode?: string;
  model?: string;
  provider?: string;
  sessionId?: string | null;
  hermesSessionId?: string;
  contextWindow?: number;
  estimatedTokens?: number;
  compacted?: boolean | "unknown";
  compactionDetails?: string;
  warning?: string;
}

export function createContextDebugSnapshot(args: SnapshotArgs): ContextDebugSnapshot {
  const blocks = extractContextDebugBlocks(args.rawRequest);
  const blockTokenEstimate = blocks.reduce((sum, block) => sum + (block.tokenEstimate ?? 0), 0);
  const estimatedTokens =
    args.estimatedTokens != null && args.estimatedTokens > 0
      ? args.estimatedTokens
      : blockTokenEstimate;
  const percentUsed = args.contextWindow
    ? Math.round((estimatedTokens / args.contextWindow) * 100)
    : undefined;

  return {
    id: generateId(),
    createdAt: Date.now(),
    requestSource: args.requestSource,
    apiMode: args.apiMode,
    model: args.model,
    provider: args.provider,
    sessionId: args.sessionId ?? undefined,
    hermesSessionId: args.hermesSessionId,
    contextWindow: args.contextWindow,
    estimatedTokens,
    percentUsed,
    compacted: args.compacted,
    compactionDetails: args.compactionDetails,
    warning: args.warning,
    messageCount: countPayloadMessages(args.rawRequest) ?? blocks.length,
    blocks,
    rawRequest: args.rawRequest,
  };
}

export function extractContextDebugBlocks(rawRequest: unknown): ContextDebugBlock[] {
  const root = asRecord(rawRequest);
  const messages = Array.isArray(root?.messages) ? root.messages : null;
  if (messages) return extractMessageBlocks(messages);

  const responsesBlocks = extractResponsesApiBlocks(root);
  if (responsesBlocks.length > 0) return responsesBlocks;

  return [
    makeBlock({
      type: "unknown",
      title: "Request payload",
      content: stringifyForDebug(rawRequest),
    }),
  ];
}

function extractMessageBlocks(messages: unknown[]): ContextDebugBlock[] {
  const blocks: ContextDebugBlock[] = [];
  messages.forEach((message, index) => {
    const record = asRecord(message);
    if (!record) {
      blocks.push(
        makeBlock({
          type: "unknown",
          title: `Message ${index + 1}`,
          content: stringifyForDebug(message),
        })
      );
      return;
    }

    const role = typeof record.role === "string" ? record.role : undefined;
    const content = record.content;
    blocks.push(...blocksFromContent(content, role, index, record));

    const toolCalls = record.tool_calls;
    if (Array.isArray(toolCalls)) {
      toolCalls.forEach((toolCall, toolIndex) => {
        blocks.push(
          makeBlock({
            type: "tool_call",
            role,
            title: `Tool call ${toolIndex + 1}`,
            content: stringifyForDebug(toolCall),
            metadata: asMetadata(toolCall),
          })
        );
      });
    }
  });

  return blocks;
}

function extractResponsesApiBlocks(root: Record<string, unknown> | null): ContextDebugBlock[] {
  if (!root) return [];
  const blocks: ContextDebugBlock[] = [];

  if (typeof root.instructions === "string" && root.instructions.trim()) {
    blocks.push(
      makeBlock({
        type: "system",
        role: "system",
        source: "responses.instructions",
        title: "System instructions",
        content: root.instructions,
      })
    );
  }

  const input = root.input;
  if (typeof input === "string") {
    blocks.push(
      makeBlock({
        type: "user",
        role: "user",
        source: "responses.input",
        title: "Input",
        content: input,
      })
    );
  } else if (Array.isArray(input)) {
    blocks.push(...extractResponsesInputBlocks(input));
  }

  const tools = root.tools;
  if (Array.isArray(tools) && tools.length > 0) {
    const fullToolSchemas = stringifyForDebug(tools);
    blocks.push(
      makeBlock({
        type: "tool_schema",
        source: "responses.tools",
        title: `Available tool schemas (${tools.length})`,
        content: summarizeToolSchemas(tools),
        tokenEstimate: estimateTokens(fullToolSchemas),
      })
    );
  }

  return blocks;
}

function extractResponsesInputBlocks(input: unknown[]): ContextDebugBlock[] {
  const blocks: ContextDebugBlock[] = [];
  input.forEach((item, index) => {
    const record = asRecord(item);
    if (!record) {
      blocks.push(
        makeBlock({
          type: "unknown",
          source: "responses.input",
          title: `Input item ${index + 1}`,
          content: stringifyForDebug(item),
        })
      );
      return;
    }

    const type = typeof record.type === "string" ? record.type : "";
    const role = typeof record.role === "string" ? record.role : undefined;
    const content = record.content ?? record.text ?? record.output;
    const blockType = responsesItemType(record, role, type);

    if (Array.isArray(content)) {
      content.forEach((part, partIndex) => {
        blocks.push(
          makeBlock({
            type: responsesContentPartType(part, blockType),
            role,
            source: `responses.input.${type || "item"}`,
            title: `${titleForRole(role, index)} part ${partIndex + 1}`,
            content: renderResponsesContentPart(part),
            metadata: asMetadata(part),
          })
        );
      });
    } else {
      blocks.push(
        makeBlock({
          type: blockType,
          role,
          source: `responses.input.${type || "item"}`,
          title: responseItemTitle(record, index, blockType),
          content: stringifyForDebug(content ?? item),
          metadata: record,
        })
      );
    }
  });
  return blocks;
}

function responsesItemType(
  item: Record<string, unknown>,
  role: string | undefined,
  type: string
): ContextDebugBlockType {
  if (type === "function_call" || type === "tool_call") return "tool_call";
  if (type === "function_call_output" || type === "tool_result") return "tool_result";
  if (type.includes("reasoning") || type.includes("summary")) return "summary";
  if (type.includes("image") || type.includes("audio")) return "attachment";
  return roleToBlockType(role);
}

function responsesContentPartType(part: unknown, fallback: ContextDebugBlockType): ContextDebugBlockType {
  const record = asRecord(part);
  const type = typeof record?.type === "string" ? record.type : "";
  if (type === "input_text" || type === "output_text" || type === "text") return fallback;
  if (type.includes("image") || type.includes("audio")) return "attachment";
  if (type.includes("tool")) return "tool_call";
  if (type.includes("reasoning") || type.includes("summary")) return "summary";
  return fallback;
}

function renderResponsesContentPart(part: unknown): string {
  const record = asRecord(part);
  if (!record) return stringifyForDebug(part);
  for (const key of ["text", "input_text", "output_text", "content"]) {
    if (typeof record[key] === "string") return record[key] as string;
  }
  return stringifyForDebug(part);
}

function responseItemTitle(
  item: Record<string, unknown>,
  index: number,
  blockType: ContextDebugBlockType
): string {
  const type = typeof item.type === "string" ? item.type : "input item";
  const role = typeof item.role === "string" ? item.role : undefined;
  const name = typeof item.name === "string" ? item.name : undefined;
  if (name) return `${labelForType(blockType)}: ${name}`;
  if (role) return titleForRole(role, index);
  if (blockType === "summary") return "Internal work summary";
  return `${type.replace(/_/g, " ")} ${index + 1}`;
}

function blocksFromContent(
  content: unknown,
  role: string | undefined,
  index: number,
  message: Record<string, unknown>
): ContextDebugBlock[] {
  if (typeof content === "string") {
    return blocksFromStringContent(content, role, index, message);
  }

  if (Array.isArray(content)) {
    return content.map((part, partIndex) => {
      const partRecord = asRecord(part);
      const type = classifyContentPart(partRecord, role);
      return makeBlock({
        type,
        role,
        source: contentPartSource(partRecord),
        title: `${labelForType(type)} ${partIndex + 1}`,
        content: renderContentPart(part),
        metadata: partRecord ? { messageIndex: index, partIndex, ...partRecord } : undefined,
      });
    });
  }

  return [
    makeBlock({
      type: roleToBlockType(role),
      role,
      title: titleForRole(role, index),
      content: stringifyForDebug(content),
      metadata: message,
    }),
  ];
}

function blocksFromStringContent(
  content: string,
  role: string | undefined,
  index: number,
  message: Record<string, unknown>
): ContextDebugBlock[] {
  const contextBlocks = extractMentionContextBlocks(content);
  const bundleBlocks = extractContextBundleBlocks(content);
  if (contextBlocks.length === 0 && bundleBlocks.length === 0) {
    return [
      makeBlock({
        type: roleToBlockType(role),
        role,
        title: titleForRole(role, index),
        content,
        metadata: message,
      }),
    ];
  }

  const blocks: ContextDebugBlock[] = [];
  for (const bundleBlock of bundleBlocks) {
    blocks.push(
      makeBlock({
        type: "mention_context",
        role,
        source: "context_bundle",
        title: `Context bundle v${bundleBlock.version}`,
        content: bundleBlock.content,
        metadata: { messageIndex: index, version: bundleBlock.version },
      })
    );
  }

  for (const contextBlock of contextBlocks) {
    blocks.push(
      makeBlock({
        type: "mention_context",
        role,
        source: contextBlock.source,
        title: "Mention context",
        content: contextBlock.content,
        metadata: { messageIndex: index },
      })
    );
  }

  const visibleContent = removeContextBundle(removeMentionContext(content)).trim();
  if (visibleContent.length > 0) {
    blocks.push(
      makeBlock({
        type: roleToBlockType(role),
        role,
        title: titleForRole(role, index),
        content: visibleContent,
        metadata: message,
      })
    );
  }
  return blocks;
}

function extractContextBundleBlocks(content: string): Array<{ version: string; content: string }> {
  const blocks: Array<{ version: string; content: string }> = [];
  const regex = /<context_bundle\s+version="([^"]*)">\n?([\s\S]*?)\n?<\/context_bundle>/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    blocks.push({
      version: match[1] || "1",
      content: match[2],
    });
  }
  return blocks;
}

function extractMentionContextBlocks(content: string): Array<{ source?: string; content: string }> {
  const blocks: Array<{ source?: string; content: string }> = [];
  const regex = /<context\s+file="([^"]*)">\n?([\s\S]*?)\n?<\/context>/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    blocks.push({
      source: decodeHtml(match[1]),
      content: match[2],
    });
  }
  return blocks;
}

function removeMentionContext(content: string): string {
  return content.replace(/<context\s+file="[^"]*">\n?[\s\S]*?\n?<\/context>\n*/g, "");
}

function removeContextBundle(content: string): string {
  return content.replace(/<context_bundle\s+version="[^"]*">\n?[\s\S]*?\n?<\/context_bundle>\n*/g, "");
}

function classifyContentPart(
  part: Record<string, unknown> | null,
  role: string | undefined
): ContextDebugBlockType {
  const type = typeof part?.type === "string" ? part.type : "";
  if (type === "image_url" || type === "input_audio") return "attachment";
  if (type.includes("summary")) return "summary";
  if (type.includes("tool")) return "tool_call";
  return roleToBlockType(role);
}

function roleToBlockType(role: string | undefined): ContextDebugBlockType {
  if (role === "system") return "system";
  if (role === "developer") return "developer";
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  if (role === "tool") return "tool_result";
  return "unknown";
}

function renderContentPart(part: unknown): string {
  const record = asRecord(part);
  if (!record) return stringifyForDebug(part);

  const type = typeof record.type === "string" ? record.type : "part";
  if (type === "text" && typeof record.text === "string") return record.text;
  if (type === "image_url") {
    const image = asRecord(record.image_url);
    const url = typeof image?.url === "string" ? image.url : "";
    return url ? `[image_url]\n${url}` : stringifyForDebug(part);
  }
  if (type === "input_audio") {
    const audio = asRecord(record.input_audio);
    const format = typeof audio?.format === "string" ? audio.format : "unknown";
    const data = typeof audio?.data === "string" ? audio.data : "";
    return `[input_audio:${format}]\n${data}`;
  }
  return stringifyForDebug(part);
}

function contentPartSource(part: Record<string, unknown> | null): string | undefined {
  if (!part) return undefined;
  const image = asRecord(part.image_url);
  if (typeof image?.url === "string") return "image_url";
  if (asRecord(part.input_audio)) return "input_audio";
  return typeof part.type === "string" ? part.type : undefined;
}

function makeBlock(args: {
  type: ContextDebugBlockType;
  role?: string;
  source?: string;
  title?: string;
  content: string;
  tokenEstimate?: number;
  metadata?: Record<string, unknown>;
}): ContextDebugBlock {
  return {
    id: generateId(),
    type: args.type,
    role: args.role,
    source: args.source,
    title: args.title,
    content: args.content,
    tokenEstimate: args.tokenEstimate ?? estimateTokens(args.content),
    metadata: args.metadata,
  };
}

function summarizeToolSchemas(tools: unknown[]): string {
  const lines = tools.map((tool, index) => {
    const record = asRecord(tool);
    const name = typeof record?.name === "string" ? record.name : `tool_${index + 1}`;
    const description = typeof record?.description === "string" ? record.description.replace(/\s+/g, " ").trim() : "";
    const preview = description.length > 140 ? `${description.slice(0, 140)}...` : description;
    return preview ? `- ${name}: ${preview}` : `- ${name}`;
  });
  return [
    "These are tool schemas made available to the model for the current request, not historical tool calls.",
    "The full schema JSON is still present in the raw provider request and counted in this block's token estimate.",
    "",
    ...lines,
  ].join("\n");
}

function titleForRole(role: string | undefined, index: number): string {
  if (!role) return `Message ${index + 1}`;
  return `${role.charAt(0).toUpperCase()}${role.slice(1)} message`;
}

function labelForType(type: ContextDebugBlockType): string {
  return type.replace(/_/g, " ");
}

function countPayloadMessages(rawRequest: unknown): number | undefined {
  const root = asRecord(rawRequest);
  if (Array.isArray(root?.messages)) return root.messages.length;
  if (Array.isArray(root?.input)) return root.input.length;
  if (typeof root?.input === "string") return 1;
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asMetadata(value: unknown): Record<string, unknown> | undefined {
  return asRecord(value) ?? undefined;
}

function stringifyForDebug(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function decodeHtml(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}
